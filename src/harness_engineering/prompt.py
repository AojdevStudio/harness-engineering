from __future__ import annotations

import re
from typing import Any

from harness_engineering.models import Issue


class PromptRenderError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


_FOR_RE = re.compile(r"{%\s*for\s+([A-Za-z_]\w*)\s+in\s+([A-Za-z_][\w.]*)\s*%}(.*?){%\s*endfor\s*%}", re.S)
_VAR_RE = re.compile(r"{{\s*([^{}]+?)\s*}}")


def render_prompt(template: str, issue: Issue, attempt: int | None) -> str:
    source = template.strip() or "You are working on an issue from GitHub."
    context: dict[str, Any] = {"issue": issue.to_dict(), "attempt": attempt}
    try:
        return _render(source, context).strip()
    except PromptRenderError:
        raise
    except Exception as exc:  # pragma: no cover - defensive boundary
        raise PromptRenderError("template_render_error", str(exc)) from exc


def _render(template: str, context: dict[str, Any]) -> str:
    def render_loop(match: re.Match[str]) -> str:
        loop_var, iterable_expr, body = match.groups()
        iterable = _resolve(iterable_expr, context)
        if iterable is None:
            raise PromptRenderError("template_render_error", f"unknown iterable {iterable_expr!r}")
        if not isinstance(iterable, list):
            raise PromptRenderError("template_render_error", f"{iterable_expr!r} is not iterable")
        rendered = []
        for item in iterable:
            child = dict(context)
            child[loop_var] = item
            rendered.append(_render(body, child))
        return "".join(rendered)

    previous = None
    current = template
    while previous != current:
        previous = current
        current = _FOR_RE.sub(render_loop, current)

    if "{%" in current or "%}" in current:
        raise PromptRenderError("template_parse_error", "unsupported template tag")

    def render_var(match: re.Match[str]) -> str:
        expression = match.group(1).strip()
        if "|" in expression:
            raise PromptRenderError("template_render_error", f"unknown filter in {expression!r}")
        value = _resolve(expression, context)
        if value is None:
            return ""
        return str(value)

    return _VAR_RE.sub(render_var, current)


def _resolve(expression: str, context: dict[str, Any]) -> Any:
    parts = expression.split(".")
    if not parts or parts[0] not in context:
        raise PromptRenderError("template_render_error", f"unknown variable {expression!r}")
    value: Any = context[parts[0]]
    for part in parts[1:]:
        if isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise PromptRenderError("template_render_error", f"unknown variable {expression!r}")
    return value

