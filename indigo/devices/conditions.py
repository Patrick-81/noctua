"""
conditions.py — Évaluation de conditions génériques (P1.1).

Utilisé par TriggerManager et SequenceRunner pour filtrer
événements/poses selon un contexte.

Syntaxe :

    conditions = {
        "filter": "Ha",                # égalité stricte (str)
        "frame_type__in": ["LIGHT"],   # IN
        "hfr__gt": 3.5,                # > 3.5
        "done__gte": 10,               # >=10
        "error__ne": "",               # != ""
    }

Clés supportées : tout ce qui est dans le contexte. Suffixes :

    __eq  (défaut), __ne, __gt, __gte, __lt, __lte, __in, __nin

Compatibilité : ``{"frame_type": "LIGHT"}`` == ``{"frame_type__eq": "LIGHT"}``
et ``{"filter": ["Ha","OIII"]}`` == ``{"filter__in": ["Ha","OIII"]}``
(ancien comportement TriggerManager préservé).
"""

from __future__ import annotations

from typing import Any

_OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"}


def _split_key(key: str) -> tuple[str, str]:
    if "__" in key:
        base, op = key.rsplit("__", 1)
        if op in _OPS and base:
            return base, op
    return key, "eq"


def _coerce_num(v: Any) -> float | None:
    try:
        if isinstance(v, bool):
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _match_one(op: str, actual: Any, expected: Any) -> bool:
    # IN / NIN : expected doit être liste/tuple/set
    if op == "in":
        vals = expected if isinstance(expected, (list, tuple, set)) else [expected]
        return str(actual) in [str(x) for x in vals]
    if op == "nin":
        vals = expected if isinstance(expected, (list, tuple, set)) else [expected]
        return str(actual) not in [str(x) for x in vals]
    if op == "eq":
        # compat : si expected est liste, interpréter comme IN
        if isinstance(expected, (list, tuple, set)):
            return str(actual) in [str(x) for x in expected]
        return str(actual) == str(expected)
    if op == "ne":
        if isinstance(expected, (list, tuple, set)):
            return str(actual) not in [str(x) for x in expected]
        return str(actual) != str(expected)
    # comparaisons numériques
    a_num = _coerce_num(actual)
    e_num = _coerce_num(expected)
    if a_num is None or e_num is None:
        # fallback lexicographique
        try:
            a_s, e_s = str(actual), str(expected)
            if op == "gt":
                return a_s > e_s
            if op == "gte":
                return a_s >= e_s
            if op == "lt":
                return a_s < e_s
            if op == "lte":
                return a_s <= e_s
        except Exception:
            return False
        return False
    if op == "gt":
        return a_num > e_num
    if op == "gte":
        return a_num >= e_num
    if op == "lt":
        return a_num < e_num
    if op == "lte":
        return a_num <= e_num
    return False


def evaluate(conditions: dict | None, ctx: dict) -> bool:
    """Retourne True si toutes les conditions matchent le contexte."""
    if not conditions:
        return True
    for raw_key, expected in conditions.items():
        key, op = _split_key(raw_key)
        actual = ctx.get(key)
        # clé absente → échec sauf op == "ne"/"nin" avec expected non vide ?
        # on reste strict : absence = False
        if actual is None:
            # autoriser test d'absence : {"error__eq": ""} si ctx n'a pas "error"
            # → on considère valeur "" pour la comparaison eq/ne
            if op in ("eq", "ne") and expected == "":
                actual = ""
            else:
                return False
        if not _match_one(op, actual, expected):
            return False
    return True


# alias pour compatibilité
match_conditions = evaluate
