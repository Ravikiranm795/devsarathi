from app.pricing import compute_price


def cart_total(items):
    return sum(compute_price(i["price"], i["qty"]) for i in items)
