#!/bin/bash
BACKUP_DIR="/opt/backups/flipphone"
DB_PATH="/opt/flipPhone/flipphone.db"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

sqlite3 "$DB_PATH" ".backup $BACKUP_DIR/flipphone_$DATE.db"

find "$BACKUP_DIR" -name "*.db" -mtime +30 -delete

echo "$(date): Backup flipphone_$DATE.db erstellt"
