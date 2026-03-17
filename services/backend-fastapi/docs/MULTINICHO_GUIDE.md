# Guía de Configuración Multinicho (agentDomainProfileJson)

## ¿Qué es?

El perfil de dominio define cómo se comporta el agente IA según el nicho de tu empresa. Se configura por company en la tabla `company_runtime_settings`.

---

## Método 1: Configuración por JSON (Prompt)

### Estructura completa

```json
{
  "domainLabel": "inmobiliarias",
  "assistantIdentity": "asesor inmobiliario",
  "offeringLabel": "propiedades",
  "offerCollectionLabel": "catálogo de propiedades",
  "primaryObjective": "entender necesidad del cliente, mostrar propiedades relevantes y coordinar visitas",
  "qualificationFields": [
    "zona",
    "presupuesto",
    "tipo de propiedad",
    "cantidad de ambientes",
    "plazo"
  ],
  "objectionPlaybook": {
    "price": "Te muestro opciones más accesibles en la misma zona.",
    "timing": "Armamos una propuesta por etapas para adaptar fechas.",
    "competitor": "Nuestra diferencia es el seguimiento personalizado post-visita."
  },
  "closingCta": "Si te parece, coordinamos la visita para esta semana.",
  "visitCta": "Decime qué día y horario te queda cómodo para visitar.",
  "criteriaKeywords": [
    "busco",
    "quiero",
    "necesito",
    "presupuesto",
    "precio",
    "zona",
    "barrio",
    "departamento",
    "casa",
    "alquiler",
    "compra"
  ]
}
```

### Campos explicados

| Campo | Descripción | Ejemplo |
|-------|-------------|---------|
| `domainLabel` | Rubro general | "inmobiliarias", "clínicas", "educación" |
| `assistantIdentity` | Cómo se presenta el agente | "asesor inmobiliario", "asistente de admisión" |
| `offeringLabel` | Qué ofrece el negocio | "propiedades", "turnos", "cursos" |
| `offerCollectionLabel` | Nombre colectivo de ofertas | "catálogo", "disponibilidades", "programas" |
| `primaryObjective` | Objetivo principal del agente | "calificar lead y cerrar visita" |
| `qualificationFields` | Datos que нужно收集 del cliente | zona, presupuesto, plazo... |
| `objectionPlaybook` | Respuestas a objeciones comunes | price, timing, competitor |
| `closingCta` | Llamada a acción final | "coordinamos visita" |
| `visitCta` | CTA específica para instancias | "qué día te sirve" |
| `criteriaKeywords` | Palabras que disparan búsqueda | "busco", "quiero", "presupuesto" |

---

## Método 2: Configuración por Base de Conocimiento (KB)

### Cómo funciona

En lugar de hardcodear el JSON, el agente puede inferir el perfil desde la KB de la empresa.

**En tu base de conocimiento (KB), creá un documento llamado:**

```
 perfil-del-agente.txt
```

**Contenido ejemplo:**

```
# Perfil del Agente

## Identidad
- Rubro: INMOBILIARIO
- Nombre: Asesor Inmobiliario
- Objetivo: Calificar leads y coordinar visitas

## Objeciones
- PRECIO: Te muestro opciones más accesibles en la misma zona.
- TIMING: Armamos una propuesta por etapas.
- COMPETIDOR: Nuestra diferencia es el seguimiento personalizado.

## Criterios de búsqueda
- Zona, presupuesto, tipo, ambientes, plazo
```

### El sistema lee esto automáticamente

El agente IA lee el documento `perfil-del-agente.txt` de la KB y construye el perfil dinámicamente.

---

## Ejemplos por Nicho

### Inmobiliario

```json
{
  "domainLabel": "inmobiliarias",
  "assistantIdentity": "asesor inmobiliario",
  "offeringLabel": "propiedades",
  "offerCollectionLabel": "catálogo de propiedades",
  "qualificationFields": ["zona", "presupuesto", "tipo", "ambientes", "plazo"],
  "criteriaKeywords": ["busco", "quiero", "zona", "barrio", "departamento", "casa", "alquiler"]
}
```

### Clínica Dental

```json
{
  "domainLabel": "clínicas dentales",
  "assistantIdentity": "asistente de admisión",
  "offeringLabel": "turnos y tratamientos",
  "offerCollectionLabel": "disponibilidades y opciones",
  "qualificationFields": ["motivo de consulta", "urgencia", "obra social", "disponibilidad horaria"],
  "criteriaKeywords": ["turno", "consulta", "tratamiento", "dolor", "obra social", "horario"]
}
```

### Educación

```json
{
  "domainLabel": "educación",
  "assistantIdentity": "asesor académico",
  "offeringLabel": "programas y cursos",
  "offerCollectionLabel": "planes de estudio",
  "qualificationFields": ["objetivo", "nivel actual", "disponibilidad", "presupuesto"],
  "criteriaKeywords": ["curso", "carrera", "programa", "beca", "inscripción", "clases", "horarios"]
}
```

### Automotor

```json
{
  "domainLabel": "automotor",
  "assistantIdentity": "asesor comercial de autos",
  "offeringLabel": "vehículos",
  "offerCollectionLabel": "stock disponible",
  "qualificationFields": ["marca", "modelo", "presupuesto", "año", "tipo de financiación"],
  "criteriaKeywords": ["auto", "camioneta", "0km", "usado", "plan de ahorro", "financiación"]
}
```

---

## Cómo aplicarlo en el sistema

### Opción A: Via API

```bash
curl -X PUT https://login.charlott.ai/api/settings/whatsapp-cloud \
  -H "Content-Type: application/json" \
  -d '{"agentDomainProfileJson": "{\"domainLabel\":\"...\",\"assistantIdentity\":\"...\",...}"}'
```

### Opción B: Via Panel (próximamente)

En Settings → Agente IA → Perfil de Dominio

---

## Checklist de configuración

- [ ] Definir `domainLabel`
- [ ] Elegir `assistantIdentity`
- [ ] Definir `offeringLabel` y `offerCollectionLabel`
- [ ] Escribir `primaryObjective`
- [ ] Listar `qualificationFields` (máx 5)
- [ ] Configurar `objectionPlaybook` (mín 2 objeciones)
- [ ] Escribir `closingCta` y `visitCta`
- [ ] Listar `criteriaKeywords` (mín 10 palabras)
- [ ] Testear con conversación real
