"""The Cloud Storage SDK, loaded only if something actually reaches for it.

── WHY THIS IS NOT JUST `from google.cloud import storage` ─────────────────────

store.py's own docstring says UNCONFIGURED IS A VALID STATE: with no
ALERTS_BUCKET the module must still import and every operation must return an
error rather than raise, so the service boots and the endpoints that know
nothing about buckets are untouched.

A MODULE-LEVEL SDK IMPORT BREAKS THAT PROMISE ONE LAYER DOWN. The env var being
unset is handled; the LIBRARY being absent was not, and it fails harder --
ImportError at import time, before any function can return anything. That is
what it does off Cloud Run: fr24.py needs pollstate.py for its circuit breaker,
pollstate and store both need a bucket, and so the forty offline tests that
never touch a network could not run without a cloud dependency installed.

── ABSENT MEANS DISABLED, NOT BROKEN ───────────────────────────────────────────

The same discipline fr24.py applies to a missing token and store.py applies to a
missing bucket. A caller gets None and degrades; nothing raises.

_NoErrors EXISTS SO THE `except` CLAUSES STAY VALID when there are no real
exception types to catch. They are still written, still compiled, and simply
never match -- which is better than branching every error path on whether a
library is installed.
"""
_storage = None
_errors = None
_tried = False


class _NoErrors(Exception):
    """Never raised. Stands in for the SDK's exception types when it is absent."""


class _AbsentErrors:
    GoogleAPIError = _NoErrors
    PreconditionFailed = _NoErrors
    NotFound = _NoErrors
    Forbidden = _NoErrors


def sdk():
    """The storage module, or None when the library is not installed."""
    global _storage, _errors, _tried
    if not _tried:
        _tried = True
        try:
            from google.api_core import exceptions as api_exceptions
            from google.cloud import storage
            _storage, _errors = storage, api_exceptions
        except ImportError:
            _storage, _errors = None, None
    return _storage


def errors():
    """The SDK's exception namespace, or a stand-in whose types never match."""
    sdk()
    return _errors if _errors is not None else _AbsentErrors


def available() -> bool:
    return sdk() is not None
