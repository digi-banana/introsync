FROM node:22-alpine
# ffmpeg: fingerprint detection (fingerprint.mjs) reads audio snippets and single frames
RUN apk add --no-cache curl tini tzdata ffmpeg
WORKDIR /app
COPY app/ /app/
ENV TIDB_DATA_DIR=/data \
    TIDB_LEDGER=/data/tidb.db \
    TIDB_API_KEY_FILE=/config/api_key \
    TIDB_BACKUP_DIR=/backups \
    PLEX_DB="/plex/Plug-in Support/Databases/com.plexapp.plugins.library.db" \
    PLEX_PREFS=/plex/Preferences.xml \
    PLEX_URL=http://192.168.0.100:32400 \
    WEB_PORT=8897 \
    NODE_NO_WARNINGS=1 \
    TZ=America/New_York
USER 99:100
EXPOSE 8897
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s CMD curl -fsS http://127.0.0.1:8897/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/main.mjs"]
