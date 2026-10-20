"""HUD Ad Gems are separate from free Store gems and orbiting diamonds."""
import time
import re
import random
import math
import traceback
import uuid
import subprocess
import cv2
from device import act, capture, overlays
from vision import wave_reader, screen
from runtime import logger
from interactions.tourney import Abort
from player.gather_settings import AD_GEM_FIELDS, resolve_ad_gem_options
import settings

TEMPLATE = 'buttons/ad_gems_claim.png'
EDGE_INSET_PX = AD_GEM_FIELDS['edge_inset_px']['default']
OBSERVATION_TIMEOUT_SEC = 2.0
MAX_OCR_CANDIDATES = 2


class RecognitionIncomplete(Exception):
    """The bounded search cannot establish either presence or absence."""


def _remaining(deadline):
    remaining = deadline-time.monotonic()
    if remaining <= 0:
        raise RecognitionIncomplete('recognition_deadline')
    return remaining

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


def find_claim_rect(frame, *, deadline=None):
    """Return a verified rectangle, None for absence, or raise if incomplete.

    Each search has a local time cap; a caller's earlier deadline wins.
    No partially searched or timed-out frame can prove offer disappearance.
    """
    local_deadline = time.monotonic()+OBSERVATION_TIMEOUT_SEC
    deadline = local_deadline if deadline is None else min(deadline, local_deadline)
    _remaining(deadline)
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
        candidates = sorted((cv2.boundingRect(contour) for contour in contours),
                            key=lambda rect: (rect[1], rect[0]))
        checked = 0
        for x,y,w,h in candidates:
            _remaining(deadline)
            if not (100<=w<=300 and 55<=h<=180): continue
            if checked >= MAX_OCR_CANDIDATES:
                raise RecognitionIncomplete('ocr_candidate_limit')
            checked += 1
            try:
                rows = textocr.read_lines(rail[y:y+h,x:x+w], 2,
                                          timeout=_remaining(deadline), raise_on_error=True)
            except subprocess.TimeoutExpired as exc:
                raise RecognitionIncomplete('ocr_timeout') from exc
            except (OSError, subprocess.SubprocessError) as exc:
                raise RecognitionIncomplete('ocr_error') from exc
            _remaining(deadline)
            text=' '.join(t for _,_,t in rows).upper()
            matched = (re.search(r'\bCLAIM\b',text)
                       and (re.search(r'\b6\b',text) or _six_amount(rail[y:y+h,x:x+w])))
            _remaining(deadline)
            if matched:
                return (rx+x,ry+y,w,h)
        _remaining(deadline)
        return None
    # Left HUD column; search vertically because wall/cards change its height.
    hay=rail
    h,w=template.shape[:2]
    if h>=hay.shape[0] or w>=hay.shape[1]:return None
    _,score,_,loc=cv2.minMaxLoc(cv2.matchTemplate(hay,template,cv2.TM_CCOEFF_NORMED))
    _remaining(deadline)
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
    def __init__(self, enabled=True, delay=(3.0, 10.0), rng=None, options=None, *, guard=None):
        self.guard = guard
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
        self.next_observation_at = 0.0
        self.visibility = 'unknown'
        self.visibility_reason = 'not_observed'
        self.first_seen_at = None
        self.last_seen_at = None
        self.last_absent_at = None
        self.last_observed_at = None
        self.appearance_after_at = None
        self.claim_rect = None
        self.window_id = None
        self.offer_id = None
        self.claim_attempt_id = None
        self.blocker = None
        self.last_failed_attempt = None
        self.counters = dict(checks=0, seen=0, skips=0, attempts=0,
                             confirmed=0, windows_missed=0)
        self.durations = dict(scheduling_wait_sec=None, response_delay_sec=None,
                              verification_sec=None, observed_wait_sec=None)
        self._trace_id = uuid.uuid4().hex[:12]
        self._window_count = self._offer_count = 0
        self._attempt_started_at = None
        self._attempt_timing = {}
        self._last_frame_evidence = {}

    def _epoch(self, value):
        return None if value is None else time.time() + value-time.monotonic()

    def _context(self):
        return dict(window_id=self.window_id, offer_id=self.offer_id,
                    claim_attempt_id=self.claim_attempt_id)

    def mark_unknown(self, reason='not_battle'):
        """Invalidate visibility without reading the device or claiming absence."""
        if self.visibility != 'unknown' or self.visibility_reason != reason:
            self.visibility = 'unknown'
            self.visibility_reason = reason
            logger.event('ad_gems_offer_unknown', reason=reason,
                         last_observed_at=self._epoch(self.last_observed_at),
                         last_seen_at=self._epoch(self.last_seen_at), **self._context())
        if reason != 'observations_lapsed':
            self._forget_offer()

    def _expire_observation(self, now):
        if (self.last_observed_at is not None
                and now-self.last_observed_at > self.options['poll_sec'][1]*2
                and self.visibility != 'unknown'):
            self.mark_unknown('observations_lapsed')

    def _observe(self, frame, *, deadline=None):
        """Recognize only the supplied frame; callers own all capture decisions."""
        now = time.monotonic()
        deadline = min(now+OBSERVATION_TIMEOUT_SEC, deadline) if deadline is not None else now+OBSERVATION_TIMEOUT_SEC
        self.counters['checks'] += 1
        try:
            _remaining(deadline)
            wave = wave_reader.read_wave(frame)
            _remaining(deadline)
            name = None if wave is None else screen.identify(frame).name
            self._last_frame_evidence = dict(wave=wave, screen=name)
            _remaining(deadline)
            if wave is None or name != 'battle':
                self.mark_unknown('not_battle')
                return None
            point = find_claim_rect(frame, deadline=deadline)
            _remaining(deadline)
        except RecognitionIncomplete as exc:
            self.mark_unknown(str(exc))
            logger.event('ad_gems_recognition_incomplete', reason=str(exc),
                         duration_sec=round(time.monotonic()-now, 3), **self._context())
            return None
        previous = self.visibility
        self.last_observed_at = now
        self.visibility_reason = 'battle_frame'
        self.claim_rect = point
        if point is None:
            self.visibility = 'absent'
            self.last_absent_at = now
            if previous == 'visible':
                logger.event('ad_gems_offer_lost',
                             first_seen_at=self._epoch(self.first_seen_at),
                             last_seen_at=self._epoch(self.last_seen_at),
                             waited_sec=round(now-self.first_seen_at, 3), **self._context())
            self._forget_offer()
            return None
        self.visibility = 'visible'
        self.last_seen_at = now
        if previous != 'visible':
            self._offer_count += 1
            self.offer_id = f'{self._trace_id}:offer:{self._offer_count}'
            self.first_seen_at = now
            self.appearance_after_at = self.last_absent_at if previous == 'absent' else None
            self.counters['seen'] += 1
            logger.event('ad_gems_offer_seen', claim_rect=point,
                         first_seen_at=self._epoch(now),
                         appearance_after_at=self._epoch(self.appearance_after_at),
                         appearance_bound_sec=None if self.appearance_after_at is None else
                         round(now-self.appearance_after_at, 3),
                         collection_active=self.window_deadline is not None,
                         next_window_at=self._epoch(self.next_window_at), **self._context())
        return point

    def _finish_attempt(self, outcome, reason, **fields):
        now = time.monotonic()
        self.durations.update(self._attempt_timing,
                              verification_sec=round(now-self._attempt_started_at, 3),
                              observed_wait_sec=None if self.first_seen_at is None else
                              round(now-self.first_seen_at, 3))
        result = dict(outcome=outcome, reason=reason, confirmed=outcome == 'confirmed',
                      observed_at=time.time(), **self._context(),
                      **self.durations, **fields)
        self.last_outcome = result
        if outcome == 'confirmed':
            self.counters['confirmed'] += 1
            self.blocker = None
        else:
            self.last_failed_attempt = dict(result)
            self.blocker = reason
            if outcome in ('skipped', 'tap_refused', 'error'):
                self.counters['skips'] += 1
        logger.event('ad_gems_attempt_finished', **result)

    def _skip(self, reason, **fields):
        logger.event('ad_gems_skip', reason=reason, **self._context(), **fields)
        self._finish_attempt('skipped', reason, **fields)

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
        if not self.enabled and not self.manual_active and not self.manual_requested:
            self.mark_unknown('disabled')
        self._expire_observation(now)
        blocker = self.blocker
        if self.visibility == 'unknown':
            blocker = self.visibility_reason
        elif not self.enabled and not self.manual_active:
            blocker = 'disabled'
        elif self.window_deadline is None:
            blocker = 'scheduled_pause'
        elif self.claim_at is not None and now < self.claim_at:
            blocker = 'response_delay'
        elif self.visibility == 'absent':
            blocker = 'offer_absent'
        elif self.claim_at is not None and now < self.next_at:
            blocker = 'next_check'
        return dict(enabled=self.enabled, state='active' if self.window_deadline is not None else 'scheduled' if self.enabled else 'off',
                    next_due_at=epoch + self.next_window_at-now if self.next_window_at else epoch,
                    window_ends_at=None if self.window_deadline is None else epoch+self.window_deadline-now,
                    manual_pending=self.manual_requested, manual_active=self.manual_active,
                    last_outcome=self.last_outcome, server_time=epoch,
                    visibility=self.visibility, visibility_reason=self.visibility_reason,
                    first_seen_at=self._epoch(self.first_seen_at),
                    last_seen_at=self._epoch(self.last_seen_at),
                    last_absent_at=self._epoch(self.last_absent_at),
                    last_observed_at=self._epoch(self.last_observed_at),
                    appearance_after_at=self._epoch(self.appearance_after_at),
                    observation_age_sec=None if self.last_observed_at is None else round(now-self.last_observed_at, 3),
                    stale_after_sec=self.options['poll_sec'][1]*2,
                    claim_rect=self.claim_rect,
                    response_due_at=self._epoch(self.claim_at),
                    response_started_at=self._epoch(self.offer_seen_at),
                    next_check_at=self._epoch(self.next_observation_at),
                    window_started_at=self._epoch(self.window_started_at),
                    blocker=blocker, last_failed_attempt=self.last_failed_attempt,
                    counters=dict(self.counters), durations=dict(self.durations), **self._context())

    def _forget_offer(self):
        self.offer_seen_at = None
        self.claim_at = None

    def _close_window(self, reason='timeout'):
        if reason == 'timeout':
            self.counters['windows_missed'] += 1
        logger.event('ad_gems_window_ended', reason=reason,
                     pause_sec=round(max(0, self.next_window_at-time.monotonic()), 3),
                     duration_sec=round(time.monotonic()-self.window_started_at, 3),
                     counters=dict(self.counters), last_failed_attempt=self.last_failed_attempt,
                     response_due_at=self._epoch(self.claim_at), **self._context())
        self.window_deadline = None
        self.window_started_at = None
        self.manual_active = False
        if reason != 'confirmed':
            self.last_outcome = dict(confirmed=False, reason=reason, observed_at=time.time(), **self._context())
        self._forget_offer()
        self.next_at = self.next_window_at

    def _window_expired(self):
        if time.monotonic() >= self.window_deadline:
            self._close_window()
            return True
        return False

    def poll(self, frame):
        """Observe carried battle frames even between collection windows.

        Passive checks never capture or input. Only the original collection
        window and response deadline authorize fresh verification and a tap.
        """
        if self.guard is not None:
            frame = self.guard(frame, "battle")
        now = time.monotonic()
        if self.window_deadline is not None and now >= self.window_deadline:
            self._close_window()
        manual = self.manual_requested
        if not manual and not self.manual_active and not self.enabled:
            self.mark_unknown('disabled')
            return frame
        self._expire_observation(now)
        action_due = manual or now >= self.next_at
        if action_due and self.window_deadline is None and (manual or now >= self.next_window_at):
            # Pausing does not award a missed window on re-enable. Advance
            # over wholly elapsed windows, preserving the previous anchor.
            duration = min(self.options['attempt_timeout_sec'], self.options['confirmed_cooldown_sec'][0])
            if not manual and self.next_window_at and now >= self.next_window_at + duration:
                interval = self.options['confirmed_cooldown_sec'][0]
                missed = math.floor((now-self.next_window_at)/interval)+1
                self.next_window_at += missed*interval
                self.next_at = self.next_window_at
                self.counters['windows_missed'] += missed
                logger.event('ad_gems_windows_missed', count=missed,
                             next_window_at=self._epoch(self.next_window_at), **self._context())
                action_due = False
            else:
                interval = self.rng.uniform(*self.options['confirmed_cooldown_sec'])
                self.window_started_at = self.last_window_started_at = now
                self.manual_requested = False
                self.manual_active = manual
                self.next_window_at = now + interval
                duration = min(self.options['attempt_timeout_sec'], interval)
                self.window_deadline = now + duration
                self._window_count += 1
                self.window_id = f'{self._trace_id}:window:{self._window_count}'
                self.claim_attempt_id = None
                self.blocker = None
                logger.event('ad_gems_window', duration_sec=duration, interval_sec=interval,
                             window_deadline=self._epoch(self.window_deadline),
                             next_window_at=self._epoch(self.next_window_at), **self._context())
        action_due = action_due and self.window_deadline is not None
        if not action_due and now < self.next_observation_at:
            return frame
        next_check = now+self.rng.uniform(*self.options['poll_sec'])
        self.next_observation_at = next_check
        if action_due:
            self.next_at = min(self.window_deadline, next_check)
        try:
            point = self._observe(frame, deadline=self.window_deadline)
        except Exception as exc:
            self.mark_unknown('recognition_error')
            logger.event('ad_gems_observation_error', error=str(exc),
                         error_type=type(exc).__name__, traceback=traceback.format_exc(),
                         **self._context())
            return frame
        if self.window_deadline is not None and self._window_expired():
            return frame
        now = time.monotonic()
        if not action_due or point is None:
            return frame
        if self.claim_at is None:
            self.offer_seen_at = now
            self.claim_at = now + self.rng.uniform(*self.delay)
            self.durations = dict(scheduling_wait_sec=round(max(0, now-self.first_seen_at), 3),
                                  response_delay_sec=round(self.claim_at-now, 3),
                                  verification_sec=None, observed_wait_sec=round(max(0, now-self.first_seen_at), 3))
            logger.event('ad_gems_response_scheduled', claim_rect=point,
                         response_due_at=self._epoch(self.claim_at),
                         **self.durations, **self._context())
        if now < self.claim_at:
            # Do not block farming while an offer waits. A later poll must
            # observe the offer again, then freshly verify it before input.
            self.next_at = min(self.next_at, self.claim_at)
            return frame
        offer_wait = now - self.offer_seen_at
        self._attempt_started_at = time.monotonic()
        self.counters['attempts'] += 1
        self.claim_attempt_id = f'{self._trace_id}:attempt:{self.counters["attempts"]}'
        self._attempt_timing = dict(self.durations)
        self._attempt_timing['response_wait_sec'] = round(offer_wait, 3)
        self._attempt_timing['response_overdue_sec'] = round(max(0, now-self.claim_at), 3)
        logger.event('ad_gems_attempt', claim_rect=point, **self._attempt_timing,
                     **self._context())
        self._forget_offer()
        try:
            with logger.context(**self._context()):
                return self._claim(frame, point, offer_wait)
        finally:
            # Current correlation belongs only to this synchronous attempt.
            # Terminal events and historical outcomes already hold its IDs.
            self.claim_attempt_id = None
            self._attempt_started_at = None

    def _claim(self, frame, point, offer_wait):
        """Keep all pre-input failures visible, with their complete diagnostics."""
        try:
            return self._verify_and_claim(frame, point, offer_wait)
        except Abort as exc:
            self.mark_unknown('ownership_lost')
            self._finish_attempt('interrupted', 'ownership_lost', error=str(exc),
                                 stage=self._attempt_stage, error_type=type(exc).__name__,
                                 traceback=traceback.format_exc())
            raise
        except Exception as exc:
            # No recovery input: capture/recognizer/foreground errors fail closed.
            self.mark_unknown('claim_verification_error')
            self._finish_attempt('error', 'claim_verification_error', error=str(exc),
                                 stage=self._attempt_stage, error_type=type(exc).__name__,
                                 traceback=traceback.format_exc())
            return self._attempt_latest_frame

    def _verify_and_claim(self, frame, point, offer_wait):
        self._attempt_latest_frame = frame
        # Recheck before touching a shifting HUD, not a remembered position.
        self._attempt_stage = 'fresh_capture'
        fresh=capture.grab()
        if self.guard is not None:
            fresh = self.guard(fresh, "battle")
        self._attempt_latest_frame = fresh
        self._attempt_stage = 'fresh_recognition'
        current = self._observe(fresh, deadline=self.window_deadline)
        if self.visibility == 'unknown':
            self._skip('fresh_frame_not_battle' if self.visibility_reason == 'not_battle'
                       else 'fresh_recognition_incomplete',
                       recognition_reason=self.visibility_reason, **self._last_frame_evidence)
            if time.monotonic() >= self.window_deadline:
                self._close_window()
            return fresh
        if current is None:
            self._skip('fresh_offer_missing')
            return fresh
        # The cyan contour grows/shrinks with effects behind the HUD. Keep
        # the original 12px CENTER movement guard; summing all four rectangle
        # fields counted that harmless shape noise as movement and restarted
        # the entire response delay until the collection window expired.
        if _center_displacement(current, point)>12:
            self._skip('offer_moved', observed_rect=point, fresh_rect=current,
                       center_displacement_px=_center_displacement(current, point))
            return fresh
        try:
            self._attempt_stage = 'foreground_evidence'
            visible_windows = overlays.windows(settings.instance()['serial'], visible_only=True)
            blocker = overlays.foreground_blocker(visible_windows)
        except Exception as exc:  # Missing window evidence must never permit a tap.
            self._skip('windows_unreadable', error=str(exc),
                       error_type=type(exc).__name__, traceback=traceback.format_exc())
            return fresh
        if blocker:
            self._skip(blocker, visible_windows=visible_windows)
            return fresh
        target = _claim_point(current, self.rng, self.options['edge_inset_px'])
        if target is None:
            self._skip('offer_too_small_for_safe_inset', claim_rect=current)
            return fresh
        # Capture, recognition and window-owner I/O may consume the remaining window.
        if time.monotonic() >= self.window_deadline:
            self._skip('window_expired_during_verification')
            self._close_window()
            return fresh
        self._attempt_timing['verification_before_tap_sec'] = round(time.monotonic()-self._attempt_started_at, 3)
        self._attempt_stage = 'claim_input'
        try:
            event=act.tap(*target,reason='HUD Ad Gems claim', deadline=self.window_deadline)
        except act.TapRefused as exc:
            logger.event('tap_refused',button='ad_gems',error=str(exc), **self._context())
            self._finish_attempt('tap_refused', 'tap_refused', error=str(exc),
                                 error_type=type(exc).__name__, traceback=traceback.format_exc())
            return fresh
        logger.event('ad_gems_tap',offer_wait_sec=round(offer_wait, 3),
                     claim_rect=current, edge_inset_px=self.options['edge_inset_px'],
                     verification_before_tap_sec=self._attempt_timing['verification_before_tap_sec'],
                     **self._context(), **event)
        if event.get('dry_run'):
            self._finish_attempt('dry_run', 'dry_run')
            self.next_at = min(self.window_deadline, time.monotonic()
                               + self.rng.uniform(*self.options['retry_cooldown_sec']))
            return fresh
        time.sleep(.35)
        self._attempt_stage = 'confirmation_capture'
        after=capture.grab()
        if self.guard is not None:
            after = self.guard(after, "battle")
        self._attempt_latest_frame = after
        # A menu/ad/death replacing the HUD is not evidence of a reward.
        self._attempt_stage = 'confirmation_recognition'
        self._observe(after)
        vanished = self.visibility == 'absent'
        reason = ('offer_disappeared' if vanished else
                  ('post_claim_not_battle' if self.visibility_reason == 'not_battle'
                   else 'post_claim_recognition_incomplete')
                  if self.visibility == 'unknown' else 'offer_still_visible')
        logger.event('ad_gems_claim',confirmed=vanished, reason=reason, **self._context())
        self._finish_attempt('confirmed' if vanished else 'not_confirmed', reason)
        if vanished:
            self._close_window('confirmed')
        elif not self._window_expired():
            self.next_at=min(self.window_deadline, time.monotonic()
                             + self.rng.uniform(*self.options['retry_cooldown_sec']))
        return after
