
# Use the official Deno image
FROM denoland/deno:alpine

# Set working directory
WORKDIR /app

# Copy the repository files
COPY . .

# Cache dependencies
RUN deno cache main.ts

# Render's default web service port
ENV PORT=10000
EXPOSE 10000

# Start the API using the repository's Deno task
CMD ["deno", "task", "start"]
