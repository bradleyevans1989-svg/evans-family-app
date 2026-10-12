# Evans Family app

The Evans family's shared calendar, jobs and reward points, meal prep, messages, movie night, noughts and crosses, and spelling and maths games.

Everyone signs in by tapping their photo and typing their 4-digit PIN. Kids start on 0000 and parents on 1234 until they change it in their profile.

## Running it

- On Render it runs as a Node web service (`npm ci`, then `npm start`) with `DATABASE_URL` set to a Postgres database. All tables live in their own `family` schema, so it can safely share a database with another app.
- On a laptop, `npm install && npm start` runs it at http://localhost:3000 and saves data to `local-data.json`.
