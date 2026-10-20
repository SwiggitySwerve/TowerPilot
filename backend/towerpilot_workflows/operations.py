"""Pure, transactional local operation identity. No runtime settings imports.

Domain files remain authoritative. This ledger stores their references, never
copies of reports. Device actions are never replayed by reconciliation.
"""
import hashlib
import json
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

ACTIVE = ('accepted', 'running', 'cancelling', 'applying')
STATUSES = {*ACTIVE, 'awaiting_apply', 'restoration_required', 'succeeded',
            'failed', 'interrupted', 'cancelled'}
EDGES = {
    'accepted': {'accepted', 'running', 'cancelling', 'failed', 'interrupted'},
    'running': {'running', 'cancelling', 'restoration_required', 'awaiting_apply', 'succeeded', 'failed', 'interrupted'},
    'cancelling': {'cancelled', 'restoration_required', 'failed', 'interrupted'},
    'awaiting_apply': {'applying'},
    'applying': {'applying', 'succeeded', 'awaiting_apply', 'interrupted', 'failed'},
    'failed': {'applying'}, 'interrupted': {'applying'},
    'restoration_required': set(), 'succeeded': set(), 'cancelled': set(),
}


class Conflict(ValueError):
    """A command no longer names the accepted target/revision."""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def file_revision(path):
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


class Operations:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self._db() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS operations (
                id TEXT PRIMARY KEY, device TEXT NOT NULL, kind TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
                revision INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL)''')

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        try:
            db.execute('PRAGMA busy_timeout=15000')
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _read(db, operation_id):
        row = db.execute('SELECT body FROM operations WHERE id=?', (operation_id,)).fetchone()
        if row is None:
            raise KeyError(operation_id)
        return json.loads(row[0])

    def get(self, operation_id):
        with self._db() as db:
            return self._read(db, operation_id)

    def active(self, device=None):
        placeholders = ','.join('?' for _ in ACTIVE)
        with self._db() as db:
            if device is None:
                rows = db.execute(f'SELECT body FROM operations WHERE status IN ({placeholders})', ACTIVE).fetchall()
            else:
                rows = db.execute(f'SELECT body FROM operations WHERE device=? AND status IN ({placeholders})', (device, *ACTIVE)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def latest(self, context, kind=None):
        with self._db() as db:
            rows = db.execute('SELECT body FROM operations ORDER BY rowid DESC').fetchall()
        for row in rows:
            op = json.loads(row[0])
            if kind is not None and op['kind'] not in ((kind,) if isinstance(kind, str) else kind):
                continue
            if all(op['context'].get(k) == context.get(k) for k in ('instance', 'account', 'serial', 'profile', 'rendering')):
                return op
        return None

    def accept(self, kind, context, command, idempotency_key=None):
        key = idempotency_key or str(uuid.uuid4())
        fingerprint = digest({'kind': kind, 'context': context, 'request': command})
        device = context['device_key']
        with self._db() as db:
            row = db.execute('SELECT body,fingerprint FROM operations WHERE idempotency_key=?', (key,)).fetchone()
            if row:
                if row[1] != fingerprint:
                    raise Conflict('Idempotency key already belongs to another command or target')
                return json.loads(row[0]), False
            placeholders = ','.join('?' for _ in ACTIVE)
            if db.execute(f'SELECT id FROM operations WHERE device=? AND status IN ({placeholders})', (device, *ACTIVE)).fetchone():
                raise Conflict('An operation already owns this device')
            now = time.time()
            op = dict(id=str(uuid.uuid4()), kind=kind, idempotency_key=key,
                      revision=1, status='accepted', context=context, request=command,
                      worker=None, step='accepted', created_at=now, updated_at=now,
                      result_refs={}, error=None, recovery_action=None, progress={})
            db.execute('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?)',
                       (op['id'], device, kind, key, fingerprint, 1, 'accepted', json.dumps(op, sort_keys=True)))
            return op, True

    def transition(self, operation_id, expected_revision, status, **changes):
        if status not in STATUSES:
            raise ValueError('Unknown operation status')
        if set(changes) - {'worker', 'step', 'result_refs', 'error', 'recovery_action', 'readiness', 'progress'}:
            raise ValueError('Immutable operation field')
        with self._db() as db:
            op = self._read(db, operation_id)
            if op['revision'] != expected_revision:
                raise Conflict('Operation revision changed; refresh before trying again')
            if status not in EDGES[op['status']]:
                raise Conflict('Invalid operation lifecycle transition')
            op.update(changes, status=status, revision=expected_revision + 1, updated_at=time.time())
            db.execute('UPDATE operations SET revision=?,status=?,body=? WHERE id=?',
                       (op['revision'], status, json.dumps(op, sort_keys=True), operation_id))
            return op

    def reconcile(self, operation_id, alive):
        op = self.get(operation_id)
        if op['status'] in ('running', 'cancelling', 'applying') and not alive(op.get('worker')):
            return self.transition(operation_id, op['revision'], 'interrupted',
                                   error={'code': 'worker_lost', 'message': 'Worker exited without a confirmed outcome'},
                                   recovery_action='Review saved observations and restoration state before retrying')
        if op['status'] == 'accepted' and time.time() - op['updated_at'] > 30 and not alive(op.get('worker')):
            return self.transition(operation_id, op['revision'], 'interrupted',
                                   error={'code': 'launch_interrupted', 'message': 'No worker confirmed this launch'},
                                   recovery_action='Review the device before starting a new operation')
        return op

    def launched(self, operation_id, worker):
        """Persist spawn identity without overwriting a worker's newer state."""
        with self._db() as db:
            op = self._read(db, operation_id)
            if op['status'] == 'accepted' and op['worker'] is None:
                op.update(worker=worker, revision=op['revision'] + 1, updated_at=time.time())
                db.execute('UPDATE operations SET revision=?,body=? WHERE id=?', (op['revision'], json.dumps(op, sort_keys=True), operation_id))
            return op
