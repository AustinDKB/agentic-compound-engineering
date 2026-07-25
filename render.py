#!/usr/bin/env python3
"""Render templates/wireframe.html.j2 -> wireframe.html.

Run:  python3 render.py   (or: npm run render)
Edit the DATA below to change the wireframe content — no HTML copy/paste.
"""
from pathlib import Path
from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).parent

DESC = "Brief placeholder description goes here now."

DATA = {
    # Header — Main Agent stats
    "stats": [
        {"label": "Context Used", "value": "42%"},
        {"label": "Cache", "value": "87%"},
        {"label": "Thinking", "value": "High"},
    ],
    # Header — to-do list (flows in columns of 4)
    "todos": [
        "Placeholder task one", "Placeholder task two", "Placeholder task three",
        "Placeholder task four", "Placeholder task five", "Placeholder task six",
        "Placeholder task seven", "Placeholder task eight", "Placeholder task nine",
        "Placeholder task ten", "Placeholder task eleven", "Placeholder task twelve",
    ],
    # Left column — phase steps
    "steps": [
        {"name": "Scope", "desc": DESC},
        {"name": "Research", "desc": DESC},
        {"name": "Plan", "desc": DESC},
        {"name": "Execute", "desc": DESC},
        {"name": "Review", "desc": DESC},
        {"name": "Ship", "desc": DESC},
        {"name": "Compound", "desc": DESC},
    ],
    # Middle column — chat bubbles
    "messages": [
        {"cls": "msg-user", "align": "self-end", "label": "User",
         "text": "Placeholder user message goes here now.", "italic": False, "dashed": False},
        {"cls": "msg-thinking", "align": "self-start", "label": "Thinking",
         "text": "Placeholder reasoning and internal thinking here.", "italic": True, "dashed": True},
        {"cls": "msg-response", "align": "self-start", "label": "Assistant",
         "text": "Placeholder assistant response goes here now.", "italic": False, "dashed": False},
    ],
    # Right column — sub-agent output boxes (variable height via block counts)
    "sub_agents": [
        {"name": "Sub-Agent 1", "blocks": [
            {"type": "thinking", "text": "placeholder reasoning before acting."},
            {"type": "tool", "text": "read_file(path)"},
            {"type": "text", "text": "Placeholder text output between tool calls."},
            {"type": "thinking", "text": "deciding on the next step."},
        ]},
        {"name": "Sub-Agent 2", "blocks": [
            {"type": "thinking", "text": "placeholder reasoning before acting."},
            {"type": "tool", "text": "search(query)"},
            {"type": "text", "text": "Placeholder text output between tool calls."},
            {"type": "tool", "text": "write_file(path, data)"},
            {"type": "text", "text": "Another block of placeholder result text."},
        ]},
        {"name": "Sub-Agent 3", "blocks": [
            {"type": "thinking", "text": "placeholder reasoning before acting."},
            {"type": "text", "text": "Placeholder text output between tool calls."},
        ]},
        {"name": "Sub-Agent 4", "blocks": [
            {"type": "tool", "text": "list_dir(path)"},
            {"type": "text", "text": "Placeholder text output between tool calls."},
            {"type": "thinking", "text": "reviewing results so far."},
            {"type": "tool", "text": "run_tests()"},
            {"type": "text", "text": "Longer block of placeholder text that wraps onto several lines to grow this box taller."},
        ]},
        {"name": "Sub-Agent 5", "blocks": [
            {"type": "thinking", "text": "placeholder reasoning before acting."},
            {"type": "tool", "text": "fetch(url)"},
            {"type": "text", "text": "Placeholder text output between tool calls."},
        ]},
        {"name": "Sub-Agent 6", "blocks": [
            {"type": "tool", "text": "read_file(path)"},
            {"type": "thinking", "text": "placeholder reasoning before acting."},
            {"type": "text", "text": "Placeholder text output between tool calls."},
        ]},
    ],
}


def main() -> None:
    env = Environment(
        loader=FileSystemLoader(ROOT / "templates"),
        autoescape=select_autoescape(["html", "j2"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    html = env.get_template("wireframe.html.j2").render(**DATA)
    out = ROOT / "wireframe.html"
    out.write_text(html, encoding="utf-8")
    print(f"Rendered {out}")


if __name__ == "__main__":
    main()
