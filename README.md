# Atiendechat - Sistema de Atención WhatsApp

Sistema completo de atención al cliente vía WhatsApp desarrollado con Node.js, React y TypeScript.

## 🚀 Características

- ✅ **Autenticación JWT** con refresh tokens
- ✅ **Multi-tenancy** - Soporte para múltiples empresas
- ✅ **Gestión de Tickets** - Sistema completo de tickets de atención
- ✅ **Conexiones WhatsApp** - Múltiples conexiones WhatsApp por empresa
- ✅ **Gestión de Contactos** - Base de datos de contactos
- ✅ **Colas/Departamentos** - Organización por departamentos
- ✅ **Dashboard** - Estadísticas en tiempo real
- ✅ **UI Premium** - Interfaz moderna con Material-UI
- 🔄 **Socket.io** - Comunicación en tiempo real
- 🔄 **WhatsApp Integration** - Integración con Baileys (en progreso)

## 📋 Requisitos

- Node.js 20.x
- PostgreSQL 14+
- Redis 6+
- Git

## 🛠️ Instalación

### 1. Clonar el repositorio

```bash
git clone <repository-url>
cd Atiendechat
```

### 2. Backend

```bash
cd backend

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Ejecutar migraciones
npm run db:migrate

# Ejecutar seeds (crea empresa y usuario admin por defecto)
npm run db:seed

# Compilar TypeScript
npm run build

# Iniciar en desarrollo
npm run dev
```

**Usuario admin por defecto:**
- Email: `admin@atendechat.com`
- Password: `admin123`

### 3. Frontend

```bash
cd frontend

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env

# Iniciar en desarrollo
npm run dev
```

## 📁 Estructura del Proyecto

```
Atiendechat/
├── backend/
│   ├── src/
│   │   ├── config/          # Configuraciones
│   │   ├── database/        # Sequelize setup y migraciones
│   │   ├── models/          # Modelos de base de datos
│   │   ├── services/        # Lógica de negocio
│   │   ├── controllers/     # Controladores
│   │   ├── routes/          # Rutas de la API
│   │   ├── middleware/      # Middlewares
│   │   ├── helpers/         # Funciones auxiliares
│   │   ├── app.ts           # Configuración Express
│   │   └── server.ts        # Punto de entrada
│   └── package.json
│
└── frontend/
    ├── src/
    │   ├── components/      # Componentes reutilizables
    │   ├── pages/           # Páginas/vistas
    │   ├── context/         # React Context
    │   ├── services/        # Servicios API
    │   ├── layout/          # Layouts
    │   ├── routes/          # Configuración de rutas
    │   └── App.tsx
    └── package.json
```

## 🔌 API Endpoints

### Autenticación
- `POST /api/auth/login` - Iniciar sesión
- `POST /api/auth/refresh` - Renovar token

### Usuarios
- `GET /api/users` - Listar usuarios
- `POST /api/users` - Crear usuario

### WhatsApp
- `GET /api/whatsapps` - Listar conexiones
- `POST /api/whatsapps` - Crear conexión

### Contactos
- `GET /api/contacts` - Listar contactos

### Tickets
- `GET /api/tickets` - Listar tickets
- `GET /api/tickets?status=open` - Filtrar por estado

### Colas
- `GET /api/queues` - Listar colas
- `POST /api/queues` - Crear cola

## 🗄️ Modelos de Base de Datos

- **Company** - Empresas (multi-tenancy)
- **User** - Usuarios/agentes
- **Whatsapp** - Conexiones WhatsApp
- **Contact** - Contactos
- **Ticket** - Tickets de atención
- **Message** - Mensajes
- **Queue** - Colas/departamentos

## 🔐 Autenticación

El sistema utiliza JWT con refresh tokens:

1. Login con email/password
2. Recibe `token` (15min) y `refreshToken` (7 días)
3. Usa `token` en header: `Authorization: Bearer <token>`
4. Renueva con `/api/auth/refresh` cuando expire

## 🎨 Frontend

- **React 18** con TypeScript
- **Vite** para desarrollo rápido
- **Material-UI v5** para componentes
- **React Router** para navegación
- **Axios** para peticiones HTTP
- **Socket.io Client** para tiempo real

## 📦 Scripts Disponibles

### Backend
```bash
npm run dev          # Desarrollo con hot-reload
npm run build        # Compilar TypeScript
npm run start        # Producción
npm run db:migrate   # Ejecutar migraciones
npm run db:seed      # Ejecutar seeds
```

### Frontend
```bash
npm run dev          # Desarrollo
npm run build        # Build para producción
npm run preview      # Preview del build
```

## 🚀 Deployment

Ver `walkthrough.md` para instrucciones detalladas de deployment en VPS.

## 📝 Variables de Entorno

### Backend (.env)
```env
NODE_ENV=development
PORT=4000
FRONTEND_URL=http://localhost:3000

DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASS=password
DB_NAME=atendechat

JWT_SECRET=your-secret-key
JWT_REFRESH_SECRET=your-refresh-secret
JWT_EXPIRES_IN=15m

REDIS_HOST=localhost
REDIS_PORT=6379
```

### Frontend (.env)
```env
VITE_BACKEND_URL=http://localhost:4000/api
```

## 🤝 Contribuir

1. Fork el proyecto
2. Crea una rama (`git checkout -b feature/AmazingFeature`)
3. Commit cambios (`git commit -m 'Add AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abre un Pull Request

## 📄 Licencia

Este proyecto es privado y propietario.

## 👥 Autores

- Desarrollo inicial - 2026

## 🙏 Agradecimientos

- Baileys por la integración con WhatsApp
- Material-UI por los componentes
- La comunidad de Node.js y React
