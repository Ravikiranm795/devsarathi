from app.pricing import compute_price


def revenue(rows):
    return sum(compute_price(r["price"], r["qty"]) for r in rows)
