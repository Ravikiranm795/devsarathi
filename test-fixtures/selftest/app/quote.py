from app.pricing import compute_price


def quote(item):
    return compute_price(item["price"], item["qty"]) * 1.1
