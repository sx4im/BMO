"""Route blueprints for Bmo Flask gateway."""

from __future__ import annotations

from .analytics_routes import analytics_bp
from .chat_routes import chat_bp
from .customize_routes import customize_bp
from .export_routes import export_bp
from .media_routes import media_bp
from .project_routes import project_bp
from .user_routes import user_bp

__all__ = ["analytics_bp", "chat_bp", "customize_bp", "export_bp", "media_bp", "project_bp", "user_bp"]
