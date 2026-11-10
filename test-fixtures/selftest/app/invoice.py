from app.pricing import compute_price


def invoice_line(item):
    return compute_price(item["price"], item["qty"])
