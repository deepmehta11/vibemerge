"""Frozen Product AdKit model-off person-guard baseline from the controller owner."""
import concepts


def _ai(text):
    return {"_ai": True, "humans": False, "concept": text, "setting": text, "composition": ""}


def test_skincare_copy_does_not_trip_person_guard():
    for text in (
        "whipped body butter on a stone slab",
        "a rich face cream that softens skin",
        "botanical serum for the neck and lips",
        "her quiet morning ritual, cool ceramic",
    ):
        assert not concepts._shows_person(_ai(text)), text


def test_real_person_still_trips_guard():
    for text in (
        "a hand applying the cream to the wrist",
        "a model holding the jar",
        "two fingers dipping into the balm",
    ):
        assert concepts._shows_person(_ai(text)), text


def test_humans_flag_always_trips():
    assert concepts._shows_person({"_ai": True, "humans": True, "concept": "a calm still life"})
