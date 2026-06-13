"""Feature 2: tag-all (`@all`) drives the separate `tagall` trigger, distinct
from the individual `tag` trigger."""
from bridge.messaging.filtering import _message_matches_prefix


def test_tagall_trigger_matches_taggedall_payload():
    payload = {"taggedAll": True, "botMentioned": False}
    assert _message_matches_prefix(payload, {"tagall"}) is True


def test_tag_trigger_does_not_fire_on_tagall_only():
    # A tag-all message does NOT set botMentioned, so the plain `tag` trigger
    # must not fire on it.
    payload = {"taggedAll": True, "botMentioned": False}
    assert _message_matches_prefix(payload, {"tag"}) is False


def test_tagall_trigger_does_not_fire_on_individual_mention():
    payload = {"taggedAll": False, "botMentioned": True}
    assert _message_matches_prefix(payload, {"tagall"}) is False


def test_tag_trigger_still_fires_on_individual_mention():
    payload = {"taggedAll": False, "botMentioned": True}
    assert _message_matches_prefix(payload, {"tag"}) is True
