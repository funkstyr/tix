# Auth API

## Endpoints

| Route    | Method | Body                            | Purpose                     |
| -------- | ------ | ------------------------------- | --------------------------- |
| /signup  | POST   | email: string, password: string | sign up for account         |
| /signin  | POST   | email: string, password: string | sign in to existing account |
| /signout | POST   | -                               | sign out                    |
| /me      | GET    | -                               | return info about user      |
