"""Read-only snapshot of the retired CLEANILO databases for scripts/import-cleanilo-legacy.ts.

Reads the connection from .env.legacy (LEGACY_DB_HOST/PORT/USER/PASSWORD/SSLMODE; never printed),
writes a pg_dump per database plus every table as JSON lines (PostGIS points → __<col>_lat/_lng)
to ~/.local/share/cleanilo-legacy-snapshot-<date>/. The folder holds personal data: delete it
once the import is verified.

    python3 -I scripts/snapshot-cleanilo-legacy.py
    node --import tsx scripts/import-cleanilo-legacy.ts --snapshot <folder>/json [--commit]
"""
import datetime
import os
import subprocess
import sys

ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.legacy")
DATABASES = ("dbcleanilo_admin", "dbcleanilo")
SKIP_TABLES = {"spatial_ref_sys"}


def pg_env(database):
    vals = {}
    for line in open(ENV_FILE, encoding="utf-8"):
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        vals[k.strip()] = v
    if not vals.get("LEGACY_DB_PASSWORD"):
        sys.exit("LEGACY_DB_PASSWORD is empty in .env.legacy")
    return dict(
        os.environ,
        PGHOST=vals["LEGACY_DB_HOST"],
        PGPORT=vals.get("LEGACY_DB_PORT", "5432"),
        PGUSER=vals["LEGACY_DB_USER"],
        PGPASSWORD=vals["LEGACY_DB_PASSWORD"],
        PGSSLMODE=vals.get("LEGACY_DB_SSLMODE", "require"),
        PGCONNECT_TIMEOUT="15",
        PGDATABASE=database,
        # Never write to the old system.
        PGOPTIONS="-c default_transaction_read_only=on",
    )


def psql(database, query):
    r = subprocess.run(["psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query],
                       env=pg_env(database), capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"{database}: {r.stderr.strip()[:300]}")
    return r.stdout


def main():
    out = os.path.expanduser(f"~/.local/share/cleanilo-legacy-snapshot-{datetime.date.today().isoformat()}")
    os.makedirs(os.path.join(out, "json"), mode=0o700, exist_ok=True)
    for database in DATABASES:
        dump = os.path.join(out, f"{database}.dump")
        subprocess.run(["pg_dump", "-Fc", "--no-owner", "--no-privileges", "-f", dump],
                       env=pg_env(database), check=True)
        os.chmod(dump, 0o600)

        tables = [t for t in psql(database, "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1").split() if t not in SKIP_TABLES]
        geo = {}
        for line in psql(database, "select table_name, column_name from information_schema.columns where table_schema='public' and udt_name in ('geometry','geography')").splitlines():
            t, c = line.split("|")
            geo.setdefault(t, []).append(c)
        folder = os.path.join(out, "json", database)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        total = 0
        for t in tables:
            extra = "".join(f', ST_Y("{c}"::geometry) as "__{c}_lat", ST_X("{c}"::geometry) as "__{c}_lng"' for c in geo.get(t, []))
            rows = [l for l in psql(database, f'select row_to_json(x) from (select *{extra} from public."{t}") x').splitlines() if l.strip()]
            n = int(psql(database, f'select count(*) from public."{t}"').strip())
            if n != len(rows):
                sys.exit(f"{database}.{t}: count {n} != exported {len(rows)}")
            path = os.path.join(folder, f"{t}.jsonl")
            with open(path, "w", encoding="utf-8") as f:
                f.write("\n".join(rows) + ("\n" if rows else ""))
            os.chmod(path, 0o600)
            total += n
        print(f"{database}: {len(tables)} tables, {total} rows")
    print(f"Snapshot: {out}")


if __name__ == "__main__":
    main()
