def get_user(user_id):
    """Look up one user. Called by the API layer and by billing."""
    return {"id": user_id, "name": "user-" + str(user_id)}


def format_name(name):
    return name.strip().upper()
