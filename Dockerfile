FROM denoland/deno:latest

WORKDIR /app

COPY . .

RUN deno cache main.ts

EXPOSE 10000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "main.ts"]
