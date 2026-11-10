from app import services


def invoice_owner(account_id):
    return services.get_user(account_id)["name"]


def load_plugin(name):
    import importlib

    return importlib.import_module("plugins." + name)
