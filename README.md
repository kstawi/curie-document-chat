# Curie document chat

A small service for asking questions about one document and getting answers backed by quotes from it. Built as a
take-home exercise for Curie; it is not affiliated with or endorsed by Curie.

Work in progress. The design notes grow step by step in [DESIGN.md](DESIGN.md).

## Run the tests

Needs Docker with Compose. Lint, type checks and all tests run in a container against their own database:

```sh
docker compose run --rm test
```

This also starts Postgres and Redis, which keep running afterwards.

## Run the API

```sh
docker compose up --build -d --wait api
curl http://127.0.0.1:3000/ready
```

`/health` says the process is up; `/ready` also checks Postgres and Redis and answers 503 naming whichever is
missing.

Stop everything with `docker compose down`; add `-v` to delete the data as well.

## Licence

None. All rights reserved.
