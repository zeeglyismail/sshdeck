"""Feature routers — one module per domain so features evolve independently.

account      sign up / sign in / session
inventory    folders + hosts (the session tree)
credentials  identities (user+password templates) and SSH keys
sftp         per-host file manager operations
transfers    server-side host-to-host copies
portability  MobaXterm import / export
"""
from . import account, credentials, inventory, portability, sftp, transfers

all_routers = [
    account.router,
    inventory.router,
    credentials.router,
    sftp.router,
    transfers.router,
    portability.router,
]
