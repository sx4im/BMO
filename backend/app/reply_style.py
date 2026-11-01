"""Apply default prose punctuation without changing Markdown literals."""
from __future__ import annotations

import re


def allows_long_dashes(*instructions: str) -> bool:
    """Only a direct writing preference can opt out, never retrieved content."""
    allowed = False
    for text in instructions:
        for clause in re.split(r"[.!?;\n]", text or ""):
            match = re.search(r"\b(use|include|prefer|allow|avoid|omit|exclude|no|without)\b[^.!?;\n]{0,45}\b(?:em|en|long)[ -]?dash(?:es)?\b", clause, re.I)
            if match:
                negative = re.search(r"\b(?:not|never|don't|dont|cannot|can't)\b", clause[:match.end()], re.I)
                allowed = not negative and match[1].lower() not in {"avoid", "omit", "exclude", "no", "without"}
    return bool(allowed)


class ProseDashFilter:
    """Small streaming lexer: code, math, quotes and link targets stay literal.

    Retain only unfinished delimiters so provider chunk boundaries cannot
    change their meaning. Ordinary text streams immediately.
    """

    def __init__(self, *, enabled: bool = True):
        self.enabled = enabled
        self.pending = ""
        self.end = ""
        self.line_start = True
        self.previous = ""
        self.spaces = ""
        self.skip_spaces = False
        self.link_depth = 0
        self.fenced = False

    def feed(self, text: str, *, final: bool = False) -> str:
        if not self.enabled:
            return text
        self.pending += text
        out = []
        i = 0

        def emit(value):
            out.append(self.spaces + value)
            self.spaces = ""

        while i < len(self.pending):
            char = self.pending[i]
            rest = self.pending[i:]
            consumed = 1
            if not final and not self.end and (rest in {"$", "<"} or any(marker.startswith(rest) for marker in ("http://", "https://"))):
                break
            if not final and self.end and self.end.startswith(rest) and len(rest) < len(self.end):
                break
            if char == "\\" and len(rest) == 1 and not final:
                break
            if self.end:
                if self.end == "url":
                    if char.isspace():
                        self.end = ""
                elif self.end[0] in "`~":
                    run = re.match(re.escape(char) + r"+", rest)[0] if char in "`~" else ""
                    if run and i + len(run) == len(self.pending) and not final:
                        break
                    if run:
                        consumed = len(run)
                    if run and run[0] == self.end[0] and ((self.fenced and self.line_start and len(run) >= len(self.end)) or (not self.fenced and run == self.end)):
                        self.end = ""
                elif self.end == ")":
                    self.link_depth += (char == "(") - (char == ")")
                    if not self.link_depth:
                        self.end = ""
                elif rest.startswith(self.end):
                    consumed = len(self.end)
                    self.end = ""
                elif char == "\\" and len(rest) > 1:
                    consumed = 2
                emit(rest[:consumed])
            elif char == "\\" and len(rest) > 1:
                if rest[1] in "([":
                    self.end = "\\)" if rest[1] == "(" else "\\]"
                consumed = 2
                emit(rest[:consumed])
            elif char in "`~" and (char == "`" or self.line_start):
                run = re.match(re.escape(char) + r"+", rest)[0]
                if len(run) == len(rest) and not final:
                    break
                if char == "`" or len(run) >= 3:
                    self.end = run
                    self.fenced = self.line_start and len(run) >= 3
                consumed = len(run)
                emit(run)
            elif char == "$":
                self.end = "$$" if rest.startswith("$$") else "$"
                consumed = len(self.end)
                emit(self.end)
            elif char in {'"', "“", "‘"} or (char == "'" and not self.previous.isalnum()):
                self.end = {"“": "”", "‘": "’"}.get(char, char)
                emit(char)
            elif char == ">" and self.line_start:
                self.end = "\n"
                emit(char)
            elif char == "(" and self.previous == "]":
                self.end, self.link_depth = ")", 1
                emit(char)
            elif re.match(r"(?:https?://|<[/!a-zA-Z])", rest):
                # Bare URLs end at whitespace; HTML/autolinks end at >.
                self.end = ">" if char == "<" else "url"
                emit(char)
            elif char in "—–":
                self.spaces = ""
                emit("-" if char == "–" and self.previous.isdigit() else ", ")
                self.skip_spaces = True
            elif char in " \t":
                if not self.skip_spaces:
                    self.spaces += char
            else:
                emit(char)

            consumed_text = rest[:consumed]
            self.previous = consumed_text[-1]
            if char not in " \t":
                self.line_start = consumed_text.endswith("\n")
                if char not in "—–":
                    self.skip_spaces = False
            i += consumed
        self.pending = self.pending[i:]
        if final:
            out.append(self.spaces)
            self.spaces = ""
        return "".join(out)
