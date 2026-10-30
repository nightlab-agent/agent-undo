TAX = 0.2


def price(item):
    return item["cost"]


def total(items):
    return sum(price(i) for i in items)


def receipt(items):
    lines = [f"{i['name']}: {price(i)}" for i in items]
    return "\n".join(lines)
