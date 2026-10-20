"""HUD Ad Gems are separate from free Store gems and orbiting diamonds."""
import time
import re
import random
import math
import cv2
from device import act, capture, overlays
from vision import wave_reader, screen
from runtime import logger
from player.gather_settings import AD_GEM_FIELDS, resolve_ad_gem_options
import settings

TEMPLATE = 'buttons/ad_gems_claim.png'
EDGE_INSET_PX = AD_GEM_FIELDS['edge_inset_px']['default']

def _six_amount(patch):
    """Read the amount beside the gem, excluding the icon and button border."""
    h,w=patch.shape[:2]
    amount=patch[int(h*.10):int(h*.52),int(w*.5):int(w*.8)]
    mask=cv2.inRange(amount,(180,180,180),(255,255,255))
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    glyphs=[]
    for contour in contours:
        x,y,gw,gh=cv2.boundingRect(contour)
        if gh>=20 and gw>=6 and x>0 and y>0 and x+gw<mask.shape[1] and y+gh<mask.shape[0]:
            glyphs.append(mask[y:y+gh,x:x+gw])
    if len(glyphs)!=1:return False
    scores={}
    for d in range(10):
        path=settings.template_path(f'digits/{d}.png')
        if not path.exists():return False
        template=cv2.imread(str(path),cv2.IMREAD_GRAYSCALE)
        if template is None:return False
        resized=cv2.resize(glyphs[0],(template.shape[1],template.shape[0]))
        scores[d]=float(cv2.matchTemplate(resized,template,cv2.TM_CCOEFF_NORMED)[0,0])
    return scores[6]>=.8 and scores[6]-max(v for k,v in scores.items() if k!=6)>=.1


def find_claim_rect(frame):
    """Return the verified offer rectangle in native screen coordinates."""
    from player.bootstrap_layout import manifest
    rx,ry,rw,rh = manifest()['runtime_regions']['ad_gems']['search']
    rail=frame[ry:ry+rh,rx:rx+rw]
    template = cv2.imread(str(settings.template_path(TEMPLATE))) if settings.template_path(TEMPLATE).exists() else None
    if template is None:
        # Offers can be absent throughout setup (including at the daily cap).
        # Locate the cyan offer block in the manifest's left HUD rail, then
        # verify its label. Both frames in poll must independently pass.
        from vision import textocr
        hsv=cv2.cvtColor(rail,cv2.COLOR_BGR2HSV)
        mask=cv2.inRange(hsv,(75,60,150),(110,255,255))
        contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x,y,w,h=cv2.boundingRect(contour)
            if not (100<=w<=300 and 55<=h<=180): continue
            text=' '.join(t for _,_,t in textocr.read_lines(rail[y:y+h,x:x+w],2)).upper()
            if re.search(r'\bCLAIM\b',text) and (re.search(r'\b6\b',text) or _six_amount(rail[y:y+h,x:x+w])):
                return (rx+x,ry+y,w,h)
        return None
    # Left HUD column; search vertically because wall/cards change its height.
    hay=rail
    h,w=template.shape[:2]
    if h>=hay.shape[0] or w>=hay.shape[1]:return None
    _,score,_,loc=cv2.minMaxLoc(cv2.matchTemplate(hay,template,cv2.TM_CCOEFF_NORMED))
    return (rx+loc[0],ry+loc[1],w,h) if score>=.92 else None


def find_claim(frame):
    """Return the center for consumers that only need offer recognition."""
    rect = find_claim_rect(frame)
    return (rect[0]+rect[2]//2, rect[1]+rect[3]//2) if rect else None


def _center_displacement(first, second):
    """Measure HUD movement without treating contour-size noise as movement."""
    return sum(abs((first[axis] + first[axis+2]//2)
                   - (second[axis] + second[axis+2]//2)) for axis in (0, 1))


def _claim_point(rect, rng, edge_inset_px=EDGE_INSET_PX):
    """Sample the interior, reserving room for shared jitter and press drift."""
    x, y, width, height = rect
    screen_size = settings.CONFIG['screen']
    left, top = max(0, x), max(0, y)
    right = min(screen_size['width'], x+width)-1
    bottom = min(screen_size['height'], y+height)-1
    margin = edge_inset_px + settings.CONFIG['tap']['jitter_px'] + act.TAP_DRIFT_PX
    if right-left < 2*margin or bottom-top < 2*margin:
        return None
    return (rng.randint(left+margin, right-margin),
            rng.randint(top+margin, bottom-margin))

class AdGemCollector:
    def __init__(self, enabled=True, delay=(3.0, 10.0), rng=None, options=None):
        self.enabled=enabled
        self.next_at=0.0
        self.next_window_at = 0.0
        self.window_deadline = None
        self.options = resolve_ad_gem_options(options)
        self.delay = tuple(float(value) for value in delay)
        if (len(self.delay) != 2 or not all(math.isfinite(value) for value in self.delay)
                or not 0 <= self.delay[0] <= self.delay[1]):
            raise ValueError('Ad Gem delay must be a finite, nonnegative ordered range')
        self.rng = rng if rng is not None else random
        self.offer_seen_at = None
        self.claim_at = None
        self.window_started_at = None
        self.last_window_started_at = None
        self.manual_requested = False
        self.manual_active = False
        self.last_outcome = None

    def configure(self, values):
        """Install live settings without resetting the schedule or offering a new window."""
        from player.run_controls import validate_patch
        validate_patch({'routines': {'ad_gems': values}})
        if values.get('enabled') is not None:
            self.enabled = values['enabled']
        if values.get('interval_sec') is not None:
            interval = values['interval_sec']
            self.options['confirmed_cooldown_sec'] = [interval, interval]
            if self.last_window_started_at is not None:
                self.next_window_at = self.last_window_started_at + interval
                if self.window_deadline is None:
                    self.next_at = self.next_window_at
        if values.get('window_sec') is not None:
            self.options['attempt_timeout_sec'] = values['window_sec']
            if self.window_deadline is not None:
                self.window_deadline = min(self.window_deadline, self.window_started_at + values['window_sec'])
                self.next_at = min(self.next_at, self.window_deadline)
        if self.window_deadline is not None and time.monotonic() >= self.window_deadline:
            self._close_window()

    def request_now(self):
        if self.manual_requested or self.window_deadline is not None:
            return False
        self.manual_requested = True
        return True

    def status(self):
        now, epoch = time.monotonic(), time.time()
        return dict(enabled=self.enabled, state='active' if self.window_deadline is not None else 'scheduled' if self.enabled else 'off',
                    next_due_at=epoch + self.next_window_at-now if self.next_window_at else epoch,
                    window_ends_at=None if self.window_deadline is None else epoch+self.window_deadline-now,
                    manual_pending=self.manual_requested, manual_active=self.manual_active,
                    last_outcome=self.last_outcome, server_time=epoch)

    def _forget_offer(self):
        self.offer_seen_at = None
        self.claim_at = None

    def _close_window(self, reason='timeout'):
        logger.event('ad_gems_window_ended', reason=reason,
                     pause_sec=round(max(0, self.next_window_at-time.monotonic()), 3))
        self.window_deadline = None
        self.window_started_at = None
        self.manual_active = False
        self.last_outcome = dict(confirmed=reason == 'confirmed', reason=reason, observed_at=time.time())
        self._forget_offer()
        self.next_at = self.next_window_at

    def _window_expired(self):
        if time.monotonic() >= self.window_deadline:
            self._close_window()
            return True
        return False

    def poll(self, frame):
        """Return the latest observed frame, including after a claim attempt."""
        now = time.monotonic()
        if self.window_deadline is not None and now >= self.window_deadline:
            self._close_window()
        manual = self.manual_requested
        if not manual and not self.manual_active and not self.enabled:return frame
        if not manual and now<self.next_at:return frame
        if self.window_deadline is None:
            if not manual and now < self.next_window_at:
                return frame
            # Pausing does not award a missed window on re-enable. Advance
            # over wholly elapsed windows, preserving the previous anchor.
            duration = min(self.options['attempt_timeout_sec'], self.options['confirmed_cooldown_sec'][0])
            if not manual and self.next_window_at and now >= self.next_window_at + duration:
                interval = self.options['confirmed_cooldown_sec'][0]
                self.next_window_at += (math.floor((now-self.next_window_at)/interval)+1)*interval
                self.next_at = self.next_window_at
                return frame
            interval = self.rng.uniform(*self.options['confirmed_cooldown_sec'])
            self.window_started_at = self.last_window_started_at = now
            self.manual_requested = False
            self.manual_active = manual
            self.next_window_at = now + interval
            duration = min(self.options['attempt_timeout_sec'], interval)
            self.window_deadline = now + duration
            logger.event('ad_gems_window', duration_sec=duration, interval_sec=interval)
        self.next_at=min(self.window_deadline, now+self.rng.uniform(*self.options['poll_sec']))
        if wave_reader.read_wave(frame) is None:
            self._forget_offer()
            return frame
        point=find_claim_rect(frame)
        if point is None:
            if self.claim_at is not None:
                logger.event('ad_gems_offer_lost', waited_sec=round(now-self.offer_seen_at, 3))
            self._forget_offer()
            return frame
        if self.claim_at is None:
            self.offer_seen_at = now
            self.claim_at = now + self.rng.uniform(*self.delay)
            logger.event('ad_gems_offer_seen', claim_rect=point,
                         response_delay_sec=round(self.claim_at-now, 3))
        if now < self.claim_at:
            # Do not block farming while an offer waits. A later poll must
            # observe the offer again, then freshly verify it before input.
            self.next_at = min(self.next_at, self.claim_at)
            return frame
        offer_wait = now - self.offer_seen_at
        self._forget_offer()
        # Recheck before touching a shifting HUD, not a remembered position.
        fresh=capture.grab()
        if wave_reader.read_wave(fresh) is None or screen.identify(fresh).name != 'battle':
            logger.event('ad_gems_skip', reason='fresh_frame_not_battle')
            return fresh
        current=find_claim_rect(fresh)
        if current is None:
            logger.event('ad_gems_skip', reason='fresh_offer_missing')
            return fresh
        # The cyan contour grows/shrinks with effects behind the HUD. Keep
        # the original 12px CENTER movement guard; summing all four rectangle
        # fields counted that harmless shape noise as movement and restarted
        # the entire response delay until the collection window expired.
        if _center_displacement(current, point)>12:
            logger.event('ad_gems_skip', reason='offer_moved',
                         observed_rect=point, fresh_rect=current)
            return fresh
        try:
            blocker=overlays.foreground_blocker(overlays.windows(settings.instance()['serial'], visible_only=True))
        except Exception as exc:  # Missing window evidence must never permit a tap.
            blocker=f'windows_unreadable:{type(exc).__name__}'
        if blocker:
            logger.event('ad_gems_skip',reason=blocker)
            return fresh
        target = _claim_point(current, self.rng, self.options['edge_inset_px'])
        if target is None:
            logger.event('ad_gems_skip', reason='offer_too_small_for_safe_inset')
            return fresh
        # Capture, recognition and window-owner I/O may consume the remaining window.
        if self._window_expired():
            return fresh
        try:
            event=act.tap(*target,reason='HUD Ad Gems claim', deadline=self.window_deadline)
        except act.TapRefused as exc:
            logger.event('tap_refused',button='ad_gems',error=str(exc))
            return fresh
        logger.event('ad_gems_tap',offer_wait_sec=round(offer_wait, 3),
                     claim_rect=current, edge_inset_px=self.options['edge_inset_px'], **event)
        if event.get('dry_run'):
            self.next_at = min(self.window_deadline, time.monotonic()
                               + self.rng.uniform(*self.options['retry_cooldown_sec']))
            return fresh
        time.sleep(.35)
        after=capture.grab()
        # A menu/ad/death replacing the HUD is not evidence of a reward.
        vanished=(wave_reader.read_wave(after) is not None
                  and screen.identify(after).name == 'battle'
                  and find_claim_rect(after) is None)
        logger.event('ad_gems_claim',confirmed=vanished)
        if vanished:
            self._close_window('confirmed')
        elif not self._window_expired():
            self.next_at=min(self.window_deadline, time.monotonic()
                             + self.rng.uniform(*self.options['retry_cooldown_sec']))
        return after
