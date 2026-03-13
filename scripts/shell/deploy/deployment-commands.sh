#!/bin/bash
# Deployment commands for VPS
# Run this script on the VPS after uploading the package

set -e  # Exit on error

echo "========================================="
echo "Atiendechat VPS Deployment"
echo "========================================="
echo ""

# Variables
DEPLOY_DIR="/home/deploy/atendechat"
DB_NAME="atendechat"
DB_USER="atendechat_user"
DB_PASS="Atendechat2026!"

echo "Step 1: Updating system..."
apt update && apt upgrade -y

echo ""
echo "Step 2: Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version
npm --version

echo ""
echo "Step 3: Installing PostgreSQL..."
apt install -y postgresql postgresql-contrib
systemctl start postgresql
systemctl enable postgresql

echo ""
echo "Step 4: Installing Redis..."
apt install -y redis-server
systemctl start redis-server
systemctl enable redis-server

echo ""
echo "Step 5: Installing PM2..."
npm install -g pm2

echo ""
echo "Step 6: Installing Nginx..."
apt install -y nginx
systemctl start nginx
systemctl enable nginx

echo ""
echo "Step 7: Creating deploy user..."
if ! id "deploy" &>/dev/null; then
    adduser --disabled-password --gecos "" deploy
    usermod -aG sudo deploy
fi

echo ""
echo "Step 8: Configuring PostgreSQL..."
sudo -u postgres psql <<EOF
CREATE DATABASE $DB_NAME;
CREATE USER $DB_USER WITH ENCRYPTED PASSWORD '$DB_PASS';
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
ALTER DATABASE $DB_NAME OWNER TO $DB_USER;
\q
EOF

echo ""
echo "Step 9: Extracting application..."
mkdir -p $DEPLOY_DIR
tar -xzf /root/atendechat-deploy.tar.gz -C $DEPLOY_DIR
chown -R deploy:deploy $DEPLOY_DIR

echo ""
echo "Step 10: Installing backend dependencies..."
cd $DEPLOY_DIR/backend
sudo -u deploy npm install --production

echo ""
echo "Step 11: Creating backend .env..."
sudo -u deploy cat > .env <<EOF
NODE_ENV=production
PORT=4000
FRONTEND_URL=https://login.charlott.ai

DB_HOST=localhost
DB_PORT=5432
DB_USER=$DB_USER
DB_PASS=$DB_PASS
DB_NAME=$DB_NAME

JWT_SECRET=$(openssl rand -base64 32)
JWT_REFRESH_SECRET=$(openssl rand -base64 32)
JWT_EXPIRES_IN=15m

REDIS_HOST=localhost
REDIS_PORT=6379
EOF

echo ""
echo "Step 12: Running database migrations..."
sudo -u deploy npm run db:migrate

echo ""
echo "Step 13: Running database seeds..."
sudo -u deploy npm run db:seed

echo ""
echo "Step 14: Building backend..."
sudo -u deploy npm run build

echo ""
echo "Step 14b: Running post-build database migrations..."
sudo -u deploy npm run db:migrate

echo ""
echo "Step 15: Installing frontend dependencies..."
cd $DEPLOY_DIR/frontend
sudo -u deploy npm install

echo ""
echo "Step 16: Creating frontend .env..."
sudo -u deploy cat > .env <<EOF
VITE_BACKEND_URL=https://login.charlott.ai/api
EOF

echo ""
echo "Step 17: Building frontend..."
sudo -u deploy npm run build

echo ""
echo "Step 18: Configuring PM2..."
cd $DEPLOY_DIR/backend
sudo -u deploy cat > ecosystem.config.js <<'EOF'
module.exports = {
  apps: [{
    name: 'atendechat-backend',
    script: './dist/server.js',
    instances: 2,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 4000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
EOF

sudo -u deploy mkdir -p logs
sudo -u deploy pm2 start ecosystem.config.js
sudo -u deploy pm2 save
env PATH=\$PATH:/usr/bin pm2 startup systemd -u deploy --hp /home/deploy

echo ""
echo "Step 19: Configuring Nginx..."
cat > /etc/nginx/sites-available/atendechat <<'EOF'
server {
    listen 80;
    server_name login.charlott.ai;

    root /home/deploy/atendechat/frontend/dist;
    index index.html;

    access_log /var/log/nginx/atendechat-access.log;
    error_log /var/log/nginx/atendechat-error.log;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /socket.io {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
EOF

ln -sf /etc/nginx/sites-available/atendechat /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo ""
echo "Step 20: Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo ""
echo "Step 21: Installing SSL certificate..."
apt install -y certbot python3-certbot-nginx
certbot --nginx -d login.charlott.ai --non-interactive --agree-tos --email admin@charlott.ai

echo ""
echo "========================================="
echo "Deployment Complete!"
echo "========================================="
echo ""
echo "Application URL: https://login.charlott.ai"
echo "Admin credentials:"
echo "  Email: admin@atendechat.com"
echo "  Password: admin123"
echo ""
echo "Useful commands:"
echo "  pm2 status"
echo "  pm2 logs atendechat-backend"
echo "  pm2 restart atendechat-backend"
echo "  systemctl status nginx"
echo "  systemctl status postgresql"
echo "  systemctl status redis-server"
echo ""
