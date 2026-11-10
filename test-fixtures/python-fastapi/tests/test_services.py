from app import services


def test_format_name():
    assert services.format_name("  ada ") == "ADA"
