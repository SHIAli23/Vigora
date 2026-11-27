# Vigora: the API and the three web apps in one image.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first, so they are cached when only the code changes.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY backend/ backend/
COPY frontend/ frontend/

WORKDIR /app/backend

# Run as a normal user, not root. The user may create files in backend/ (a local SQLite
# file) and backend/uploads (photos), but cannot change the code.
RUN useradd --create-home vigora \
    && mkdir -p uploads \
    && chown vigora . uploads
USER vigora

EXPOSE 8000

# Hosting providers set PORT; locally it is 8000.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
