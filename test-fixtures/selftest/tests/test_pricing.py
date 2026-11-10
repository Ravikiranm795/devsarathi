from app.pricing import compute_price


def test_compute_price():
    assert compute_price(2, 3) == 6
