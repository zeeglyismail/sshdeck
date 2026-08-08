"""Parse and generate MobaXterm .mobaconf bookmark sections.

SSH bookmarks look like:
    label=#109#0%hostname%port%username%...
inside [Bookmarks] / [Bookmarks_N] sections, where SubRep= is the folder name.
Only SSH sessions (#109#) are imported; stored passwords in the file are
encrypted with the Moba master password so they cannot be imported.
"""

# Tail template copied from a real MobaXterm 25.x export so re-imported
# files render with sane terminal settings.
_TAIL = ("%%-1%-1%%%%%0%0%0%%%-1%-1%0%0%%1080%%0%0%1%%0%%%%0%-1%-1%0%%"
         "#Cascadia Code SemiBold%10%0%0%-1%15%230,225,220%43,43,43%255,255,255"
         "%5%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%0%#0# #-1")


def parse(text: str):
    """Return list of dicts: {folder, label, hostname, port, username}."""
    sessions = []
    in_bookmarks = False
    folder = ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("["):
            in_bookmarks = line.startswith("[Bookmarks")
            folder = ""
            continue
        if not in_bookmarks or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key == "SubRep":
            folder = value.strip().replace("\\", "/")
            continue
        if key == "ImgNum":
            continue
        if not value.startswith("#109#"):
            continue  # not an SSH session (e.g. RDP #91#)
        parts = value.split("%")
        if len(parts) < 4:
            continue
        hostname = parts[1].strip()
        try:
            port = int(parts[2]) if parts[2].strip() else 22
        except ValueError:
            port = 22
        username = parts[3].strip().strip("[]")
        if not hostname:
            continue
        sessions.append({
            "folder": folder,
            "label": key.strip(),
            "hostname": hostname,
            "port": port,
            "username": username,
        })
    return sessions


def export(folders_with_hosts):
    """folders_with_hosts: list of (folder_name, [host rows]). Returns text."""
    out = []
    idx = 0
    for folder_name, hosts in folders_with_hosts:
        section = "[Bookmarks]" if idx == 0 else f"[Bookmarks_{idx}]"
        out.append(section)
        out.append(f"SubRep={folder_name}")
        out.append("ImgNum=41")
        for h in hosts:
            label = h["label"] or f'{h["hostname"]} ({h["username"]})'
            out.append(f'{label}=#109#0%{h["hostname"]}%{h["port"]}%{h["username"]}{_TAIL}')
        out.append("")
        idx += 1
    return "\r\n".join(out)
