# Use the official Node.js v18 image
FROM node:18

# Create and set working directory
WORKDIR /usr/src/app

# Copy package files first (if they exist)
COPY package*.json ./

# Install dependencies (if you have package.json)
RUN npm install --production

# Copy the rest of the project files
COPY . .

# Expose port (optional, if your bot needs it)
# EXPOSE 3000

# Command to run the bot
CMD ["node", "bot.js"]
