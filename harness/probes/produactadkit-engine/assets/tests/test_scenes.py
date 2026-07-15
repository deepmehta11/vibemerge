"""Frozen Product AdKit scene-taxonomy baseline from the controller owner."""
import scenes
from core import ProductSpec


def _spec(kind="product", category="", materials=None):
    return ProductSpec(image=b"", kind=kind, category=category, materials=materials or [])


def test_every_keyword_category_has_a_world_and_vice_versa():
    kw = {category for category, _ in scenes._KEYWORDS}
    worlds = set(scenes.CATEGORY_WORLDS)
    assert kw == worlds, f"mismatch: only-keyword={kw - worlds}, only-world={worlds - kw}"
    assert len(worlds) >= 25


def test_worlds_are_well_formed():
    for category, world in scenes.CATEGORY_WORLDS.items():
        for key in ("settings", "surfaces", "props", "materials", "avoid"):
            assert isinstance(world.get(key), list) and world[key], f"{category}.{key} empty/not-list"
        assert isinstance(world.get("light"), str) and world["light"], f"{category}.light"
        assert isinstance(world.get("palette"), str) and world["palette"], f"{category}.palette"
        assert not world["light"].strip().startswith("["), f"{category}.light not flattened"
        assert not world["palette"].strip().startswith("["), f"{category}.palette not flattened"


def test_categories_lists_only_categories_with_worlds():
    assert set(scenes.categories()) == set(scenes.CATEGORY_WORLDS)


def test_classify_by_keyword_on_kind():
    cases = {
        "gold chain necklace": "jewelry",
        "cold brew coffee": "coffee_tea",
        "fresh orange juice": "beverage",
        "vitamin C gummies": "supplement",
        "leather running sneakers": "footwear",
        "single malt whisky": "alcohol",
        "scented soy candle": "candle",
        "artisan dark chocolate bar": "food",
    }
    for kind, expected in cases.items():
        assert scenes.classify(_spec(kind=kind)) == expected, kind


def test_claude_category_wins_over_keyword():
    assert scenes.classify(_spec(kind="mysterious object", category="jewelry")) == "jewelry"
    assert scenes.classify(_spec(kind="x", category="Coffee_Tea")) == "coffee_tea"


def test_classify_unknown_returns_empty():
    assert scenes.classify(_spec(kind="quux widget xyzzy")) == ""
    assert scenes.classify(_spec(kind="quux", category="not_a_category")) == ""


def test_scene_world_clause_always_has_general_directive():
    for category in ["jewelry", "food", "", "not_a_real_cat"]:
        clause = scenes.scene_world_clause(category)
        assert "SCENE WORLD" in clause and "belong to" in clause


def test_scene_world_clause_enriches_known_category():
    jewelry = scenes.scene_world_clause("jewelry")
    assert "jewelry product" in jewelry
    assert "settings —" in jewelry and "AVOID" in jewelry
    assert any(word in jewelry.lower() for word in ("velvet", "silk", "marble", "satin"))


def test_scene_world_clause_unknown_is_general_only():
    clause = scenes.scene_world_clause("")
    assert "settings —" not in clause
    assert "SCENE WORLD" in clause


def test_scene_world_clause_modulates_by_tier_and_vibe():
    spec = ProductSpec(
        image=b"",
        kind="serum",
        category="skincare",
        price_tier="luxury",
        audience="affluent women",
        vibe_words=["clinical", "potent"],
    )
    base = scenes.scene_world_clause("skincare")
    tuned = scenes.scene_world_clause("skincare", spec=spec)
    assert tuned != base
    assert "luxury" in tuned.lower() and "clinical" in tuned.lower()
    assert scenes.scene_world_clause("skincare", spec=None) == base


def test_scene_world_clause_empty_spec_is_byte_identical():
    bare = ProductSpec(image=b"", kind="serum", category="skincare")
    assert scenes.scene_world_clause("skincare", spec=bare) == scenes.scene_world_clause("skincare")
