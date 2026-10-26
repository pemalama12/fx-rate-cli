# fx-rate-cli

Lightweight CLI to fetch foreign-exchange rates (Frankfurter, no API key).

## Usage

```bash
fx-rate EUR USD
fx-rate USD "EUR,GBP,BRL" --json
fx-rate EUR USD --amount=100
fx-rate EUR USD 100 250
fx-rate EUR USD --rate=1.1 --amount=100
fx-rate EUR USD --date=2026-10-20
fx-rate EUR USD --watch=30 --count=5
```

## Options

- `--amount=N` convert N units of BASE into TARGETS (also positional amounts)
- `--rate=R` override the rate (single target only; skips the network)
- `--date=YYYY-MM-DD` historical rate on that date (cached on disk)
- `--watch[=SECS]` refresh continuously (default 30s)
- `--interval=SECS` alias for --watch=SECS
- `--count=N` stop after N refreshes
- `--clear-cache` wipe the on-disk history cache
- `--dump-cache` list cached historical rates
- `--json` machine-readable output
- `--version` print version
- `-h, --help` show help

Cache location: `$XDG_CACHE_HOME/fx-rate-cli/history` (default `~/.cache/fx-rate-cli/history`).

## Development

```bash
npm test
```

## License

MIT
