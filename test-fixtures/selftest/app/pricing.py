def compute_price(base, qty):
    """Price of a line item. Called from the cart, invoice, report and quote modules."""
    return base * qty
