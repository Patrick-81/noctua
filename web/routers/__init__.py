"""Route modules for the Noctua web server.

Each module exposes ``register(app, server)`` that attaches its routes to the
FastAPI app, receiving the ``WebServer`` instance. Keeps server.py focused on
application wiring, lifecycle and WS broadcasting.
"""
