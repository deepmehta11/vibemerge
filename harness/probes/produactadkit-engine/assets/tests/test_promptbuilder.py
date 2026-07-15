"""Frozen Product AdKit prompt-construction baseline from the controller owner."""
from core import ProductSpec
import promptbuilder


CAMPAIGN = {
    "family": "campaign",
    "concept": "High-impact luxury campaign poster.",
    "model": "A confident female model in cream tailoring,",
    "pose": "holding and presenting",
    "setting": "travertine architecture",
    "backdrop": "bright blue sky",
    "composition": "low-angle heroic medium-wide",
    "region": "upper area",
    "lighting": "warm directional daylight",
    "lens": "32mm wide-angle editorial lens",
    "mood": "powerful, editorial",
    "palette": ["#efe6d6", "#d8b98a"],
}
STILL_LIFE = {**CAMPAIGN, "family": "still_life", "concept": "Editorial product still life"}


def _spec():
    return ProductSpec(image=b"x", kind="handbag", materials=["coated canvas", "vachetta"], finish="grained")


def test_campaign_prompt_includes_product_and_finish():
    prompt = promptbuilder.build_prompt(CAMPAIGN, _spec())
    assert "handbag" in prompt
    assert "coated canvas" in prompt
    assert "grained" in prompt


def test_campaign_prompt_has_model_and_slots():
    prompt = promptbuilder.build_prompt(CAMPAIGN, _spec())
    assert "female model" in prompt
    assert "negative space" in prompt
    assert "32mm" in prompt
    assert "no cgi" in prompt.lower()


def test_campaign_reserves_named_side_and_pushes_subject_opposite():
    prompt = promptbuilder.build_prompt({**CAMPAIGN, "region": "left"}, _spec())
    assert "left side" in prompt
    assert "toward the right" in prompt
    assert "negative space" in prompt
    assert "not a tight close-up crop" in prompt


def test_campaign_right_side_mirrors():
    prompt = promptbuilder.build_prompt({**CAMPAIGN, "region": "right"}, _spec())
    assert "right side" in prompt and "toward the left" in prompt


def test_still_life_prompt_has_no_model():
    prompt = promptbuilder.build_prompt(STILL_LIFE, _spec())
    assert "female model" not in prompt
    assert "handbag" in prompt


def test_prompt_handles_missing_product_read():
    prompt = promptbuilder.build_prompt(STILL_LIFE, ProductSpec(image=b"x"))
    assert "product" in prompt.lower()


def test_campaign_prompt_survives_missing_optional_keys():
    archetype = {
        "family": "campaign",
        "concept": "Campaign poster.",
        "setting": "studio",
        "backdrop": "sky",
        "composition": "low-angle",
        "region": "upper area",
        "lighting": "daylight",
        "lens": "32mm",
        "mood": "bold",
    }
    output = promptbuilder.build_prompt(archetype, ProductSpec(image=b"x", kind="bag"))
    assert isinstance(output, str) and "bag" in output
