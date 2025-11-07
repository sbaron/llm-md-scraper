FROM mcr.microsoft.com/playwright:v1.56.1-noble

WORKDIR /app

COPY package.json ./
RUN npm install

# Copy the new server script
COPY server.js .

# Document that this container listens on port 3000
EXPOSE 3000

# Start the server
ENTRYPOINT ["node", "server.js"]