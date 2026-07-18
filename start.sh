docker build -t cm-local . && docker run -d --rm -p 3000:3000 --env-file .env cm-local
