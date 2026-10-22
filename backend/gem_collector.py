"""Collect diamonds on an existing battle; never start, equip or end a run."""
import argparse
import time
from types import SimpleNamespace
import settings
from device import capture
from runtime import logger
from vision import wave_reader, screen
from scheduling import runflag
from flows.shard import GemWatch


FENCE_RECHECK_SEC = 5


def automatic_fence():
    """For a collector the lifecycle host launched (request.harvest), a check
    that the person's choice still names exactly this launch; None for a
    collector a person started. Reads the operation ledger the worker was
    accepted into, never the environment's say-so."""
    from runtime.operations import environment_operation
    ledger, operation_id = environment_operation()
    if ledger is None:
        return None
    operation = ledger.get(operation_id)
    if operation['request'].get('harvest') is not True:
        return None
    from towerpilot_workflows.harvest import CollectorRefused, automatic_launch_valid

    def check():
        ok, code = automatic_launch_valid(ledger.path, operation)
        if not ok:
            logger.event('gem_collector_refused', reason=code)
            raise CollectorRefused(f'Harvesting no longer asks for this collector ({code}); no input was sent')
    return check


def main(instance, preset):
    from runtime.device_lease import prepare_instance
    prepare_instance(instance)
    settings.select_instance(instance,preset)
    # The collector always adopts the battle on screen. Before any runner
    # check, session or frame: the collection-scope setup guard for the bound
    # (accepted workers: restored) device and account, logged under this
    # instance. A person's collection-only handoff is read from the ledger,
    # never from the environment.
    from control.battles import require_runner_entry
    require_runner_entry(settings.ROOT, settings.CONFIG, instance, scope='collection', event=logger.event)
    from runtime.runners import other_runners
    if next(other_runners(), None) is not None:
        raise RuntimeError('Another runner owns the emulator; stop it before collecting gems')
    fence = automatic_fence()
    if fence is not None:
        fence()   # the person's Off, a new revision or a context change since acceptance: before any input
    fence_checked = time.monotonic()
    from runtime.battle_session import BattleSession
    from orchestrator import preset as resolved_preset
    session = BattleSession.from_environment(resolved_preset(), settings.CONFIG, origin='adopted')
    body = session.effective_preset() if session is not None else resolved_preset()
    gems=GemWatch(body.get('gather', {}))
    state = SimpleNamespace(gems=gems, tracker=wave_reader.WaveTracker(), mission=None, shop=None)
    wave_hwm = None
    logger.event('gem_collector_started',preset=preset,ad_gems=gems.ad_gems.enabled,orbit=gems.orbit.enabled)
    last_status=None
    saw_battle=False
    while True:
        if fence is not None and time.monotonic() - fence_checked >= FENCE_RECHECK_SEC:
            fence()
            fence_checked = time.monotonic()
        frame=capture.grab()
        sc=screen.identify(frame)
        live=sc.name == 'battle' and wave_reader.read_wave(frame) is not None
        raw = wave_reader.read_wave(frame)
        wave = state.tracker.update(raw)
        backwards = raw is not None and wave_hwm is not None and raw < wave_hwm-100
        if backwards and (wave is None or wave >= wave_hwm-100):
            continue
        if backwards:
            if session is not None and session.battle['status'] in ('prepared', 'active'):
                previous = session.battle['id']
                session.finish('wave_went_backwards', evidence={'previous_wave': wave_hwm, 'observed_wave': wave})
                session.prepare_next(origin='partial_adoption', previous_battle_id=previous)
            gems = GemWatch(body.get('gather', {}))
            state.gems = gems
            state.tracker = wave_reader.WaveTracker()
            wave_hwm = None
            continue
        if wave is not None:
            wave_hwm = wave if wave_hwm is None else max(wave_hwm, wave)
        if saw_battle and sc.name in ('game_stats', 'tournament_stats', 'home'):
            if session is not None and session.battle['status'] in ('prepared', 'active'):
                session.finish('observed_results' if sc.name != 'home' else 'battle_no_longer_observed',
                               evidence={'screen': sc.name, 'last_observed_wave': state.tracker.last})
            reason=runflag.requested()
            if reason is not None:
                logger.event('gem_collector_stopped',reason=reason)
                return
        saw_battle=saw_battle or live
        label='collecting' if live else 'waiting_for_battle'
        if label!=last_status:
            logger.event('gem_collector_state',state=label)
            last_status=label
        if live:
            if session is not None:
                if session.battle['status'] not in ('prepared', 'active'):
                    session.prepare_next(origin='adopted')
                    gems = GemWatch(body.get('gather', {}))
                    state.gems = gems
                    state.tracker = wave_reader.WaveTracker()
                    wave_hwm = None
                session.observe(state, raw)
                session.checkpoint(state, battle_visible=True)
            gems.poll(frame)
        elif session is not None and session.battle['status'] in ('prepared', 'active'):
            session.checkpoint(state, battle_visible=False)
        time.sleep(1)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--instance',required=True)
    parser.add_argument('--preset',required=True)
    args=parser.parse_args()
    try:main(args.instance,args.preset)
    except Exception as exc:
        logger.event('gem_collector_failed',error=str(exc))
        raise
