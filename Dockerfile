FROM node:16

# Create app directory
WORKDIR /app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install
# If you are building your code for production
# RUN npm ci --only=production

# Bundle app source

RUN groupadd --gid 1007 dockerrunner && useradd -r --uid 1007 -g dockerrunner dockerrunner
RUN mkdir -p log && touch log/log.txt && chown dockerrunner log/log.txt

RUN mkdir -p resources
RUN mkdir -p resources/taxoncache

RUN mkdir -p uploads

RUN mkdir -p auth
RUN mkdir -p cache


RUN mkdir -p log/taxa
#USER dockerrunner

COPY . .

CMD [ "node", "server.js" ]