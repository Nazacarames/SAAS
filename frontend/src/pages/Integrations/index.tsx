import { useState, useEffect } from 'react';
import {
    Box,
    Button,
    Paper,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    IconButton,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField,
    Switch,
    FormControlLabel,
    Typography,
    Chip,
    Select,
    MenuItem,
    FormControl,
    InputLabel
} from '@mui/material';
import {
    Add as AddIcon,
    Edit as EditIcon,
    Delete as DeleteIcon
} from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

interface Webhook {
    id: number;
    name: string;
    url: string;
    event: string;
    active: boolean;
    description?: string;
    createdAt: string;
}

const Integrations = () => {
    const [webhooks, setWebhooks] = useState<Webhook[]>([]);
    const [open, setOpen] = useState(false);
    const [editingWebhook, setEditingWebhook] = useState<Webhook | null>(null);
    const [formData, setFormData] = useState({
        name: '',
        url: '',
        event: 'message.create',
        active: true,
        description: ''
    });

    const eventOptions = [
        { value: 'message.create', label: 'Mensaje Recibido' },
        { value: 'message.sent', label: 'Mensaje Enviado' },
        { value: 'ticket.create', label: 'Ticket Creado' },
        { value: 'ticket.update', label: 'Ticket Actualizado' },
        { value: 'ticket.close', label: 'Ticket Cerrado' },
        { value: 'contact.create', label: 'Contacto Creado' },
        { value: 'contact.update', label: 'Contacto Actualizado' }
    ];

    useEffect(() => {
        loadWebhooks();
    }, []);

    const loadWebhooks = async () => {
        try {
            const { data } = await api.get('/webhooks');
            setWebhooks(data);
        } catch (error) {
            console.error('Error loading webhooks:', error);
            toast.error('Error al cargar webhooks');
        }
    };

    const handleOpen = (webhook?: Webhook) => {
        if (webhook) {
            setEditingWebhook(webhook);
            setFormData({
                name: webhook.name,
                url: webhook.url,
                event: webhook.event,
                active: webhook.active,
                description: webhook.description || ''
            });
        } else {
            setEditingWebhook(null);
            setFormData({
                name: '',
                url: '',
                event: 'message.create',
                active: true,
                description: ''
            });
        }
        setOpen(true);
    };

    const handleClose = () => {
        setOpen(false);
        setEditingWebhook(null);
    };

    const handleSave = async () => {
        try {
            if (editingWebhook) {
                await api.put(`/webhooks/${editingWebhook.id}`, formData);
                toast.success('Webhook actualizado exitosamente');
            } else {
                await api.post('/webhooks', formData);
                toast.success('Webhook creado exitosamente');
            }
            handleClose();
            loadWebhooks();
        } catch (error) {
            console.error('Error saving webhook:', error);
            toast.error('Error al guardar webhook');
        }
    };

    const handleDelete = async (id: number) => {
        if (window.confirm('¿Estás seguro de eliminar este webhook?')) {
            try {
                await api.delete(`/webhooks/${id}`);
                toast.success('Webhook eliminado exitosamente');
                loadWebhooks();
            } catch (error) {
                console.error('Error deleting webhook:', error);
                toast.error('Error al eliminar webhook');
            }
        }
    };

    // ── Google Calendar ──────────────────────────────────────────────
    const [gcal, setGcal] = useState<any>({ configurado: false, conexiones: [] });
    const [gcalBusy, setGcalBusy] = useState(false);

    const loadGcal = async () => {
        try {
            const { data } = await api.get('/integrations/google/status');
            setGcal(data || { configurado: false, conexiones: [] });
        } catch { /* la tarjeta queda en "no configurado" */ }
    };
    useEffect(() => { loadGcal(); }, []);

    const conectarGcal = async (soloMio: boolean) => {
        setGcalBusy(true);
        try {
            const { data } = await api.get('/integrations/google/auth-url', { params: { solo_mio: soloMio } });
            // ventana aparte: al volver, Google muestra el resultado y se cierra
            window.open(data.url, 'gcal', 'width=520,height=680');
            toast.info('Autorizá el acceso en la ventana de Google y despues actualizá');
        } catch (e: any) {
            toast.error(e?.response?.data?.detail || 'No se pudo iniciar la conexion');
        } finally { setGcalBusy(false); }
    };

    const sincronizarGcal = async () => {
        setGcalBusy(true);
        try {
            const { data } = await api.post('/integrations/google/sync');
            const r = (data.resultados || [])[0] || {};
            toast.success(r.ok ? `Sincronizado: ${r.creadas || 0} nuevas, ${r.actualizadas || 0} actualizadas` : (r.reason || 'Sin cambios'));
            loadGcal();
        } catch (e: any) {
            toast.error(e?.response?.data?.detail || 'No se pudo sincronizar');
        } finally { setGcalBusy(false); }
    };

    const desconectarGcal = async (id: number) => {
        if (!window.confirm('¿Desconectar este calendario? Las citas ya sincronizadas quedan como estan.')) return;
        try {
            await api.delete(`/integrations/google/${id}`);
            toast.success('Calendario desconectado');
            loadGcal();
        } catch { toast.error('No se pudo desconectar'); }
    };

    // ── Pixel de Meta ────────────────────────────────────────────────
    const [pixel, setPixel] = useState<any>({ pixel_id: '', currency: 'ARS', enabled: true });
    const [pixelId, setPixelId] = useState('');
    const [pixelToken, setPixelToken] = useState('');
    const [pixelOpciones, setPixelOpciones] = useState<any[]>([]);
    const [pixelBusy, setPixelBusy] = useState(false);

    const loadPixel = async () => {
        try {
            const { data } = await api.get('/integrations/pixel');
            setPixel(data);
            setPixelId(data.pixel_id || '');
        } catch { /* la tarjeta queda vacia */ }
    };
    useEffect(() => { loadPixel(); }, []);

    const buscarPixeles = async () => {
        setPixelBusy(true);
        try {
            const { data } = await api.get('/integrations/pixel/disponibles');
            setPixelOpciones(data.pixeles || []);
            if (!data.ok) toast.warning(data.detail || 'No se pudieron listar los píxeles');
            else if (!(data.pixeles || []).length) toast.info('El token de esta empresa no ve ningún píxel');
        } catch (e: any) {
            toast.error(e?.response?.data?.detail || 'No se pudieron buscar los píxeles');
        } finally { setPixelBusy(false); }
    };

    const [pixelTestCode, setPixelTestCode] = useState('');

    const probarPixel = async () => {
        setPixelBusy(true);
        try {
            await api.post('/integrations/pixel/probar', { test_event_code: pixelTestCode.trim() });
            toast.success('Evento enviado. Miralo en Events Manager, pestaña "Eventos de prueba"');
        } catch (e: any) {
            toast.error(e?.response?.data?.detail || 'No se pudo enviar el evento de prueba');
        } finally { setPixelBusy(false); }
    };

    const guardarPixel = async () => {
        setPixelBusy(true);
        try {
            const { data } = await api.put('/integrations/pixel', {
                pixel_id: pixelId.trim(),
                token: pixelToken.trim() || undefined,
                currency: pixel.currency || 'ARS',
                enabled: pixel.enabled,
            });
            setPixel(data);
            setPixelToken('');
            if (data.verificacion?.ok) toast.success(`Píxel "${data.verificacion.name}" verificado`);
            else toast.warning(data.verificacion?.detail || 'Guardado, pero no se pudo verificar el píxel');
        } catch (e: any) {
            toast.error(e?.response?.data?.detail || 'No se pudo guardar');
        } finally { setPixelBusy(false); }
    };

    return (
        <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                <Typography variant="h4">Integraciones & Webhooks</Typography>
                <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={() => handleOpen()}
                >
                    Nuevo Webhook
                </Button>
            </Box>

            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Configura webhooks para integrar con n8n, Zapier, Make o cualquier herramienta de automatización.
                Los eventos se enviarán en tiempo real a las URLs configuradas.
            </Typography>

            <Paper sx={{ p: 2.5, mb: 3 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                    <Typography variant="h6">Google Calendar</Typography>
                    {gcal.conexiones?.length > 0 && <Chip size="small" color="success" label="Conectado" />}
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Sincronizacion en dos vias: lo que se agenda en el CRM aparece en Google, y lo que
                    se agenda en Google baja a la Agenda y dispara los recordatorios de WhatsApp.
                </Typography>

                {!gcal.configurado && (
                    <Typography variant="body2" sx={{ color: 'warning.main', mb: 2 }}>
                        Falta cargar las credenciales de Google en el servidor.
                    </Typography>
                )}

                {(gcal.conexiones || []).map((c: any) => (
                    <Box key={c.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                        <Box sx={{ flex: 1 }}>
                            <Typography variant="body2">{c.email || 'Cuenta de Google'}</Typography>
                            <Typography variant="caption" color="text.secondary">
                                {c.user_id ? 'Calendario personal' : 'Calendario de la empresa'}
                                {c.last_sync_at ? ` · ultima sincronizacion ${new Date(c.last_sync_at).toLocaleString('es-AR')}` : ' · sin sincronizar todavia'}
                            </Typography>
                            {c.last_error && <Typography variant="caption" sx={{ color: 'error.main', display: 'block' }}>{c.last_error}</Typography>}
                        </Box>
                        <Button size="small" onClick={() => desconectarGcal(c.id)}>Desconectar</Button>
                    </Box>
                ))}

                <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
                    <Button variant="contained" disabled={!gcal.configurado || gcalBusy} onClick={() => conectarGcal(false)}>
                        Conectar calendario de la empresa
                    </Button>
                    <Button variant="outlined" disabled={!gcal.configurado || gcalBusy} onClick={() => conectarGcal(true)}>
                        Conectar el mio
                    </Button>
                    {gcal.conexiones?.length > 0 && (
                        <Button disabled={gcalBusy} onClick={sincronizarGcal}>Sincronizar ahora</Button>
                    )}
                    <Button disabled={gcalBusy} onClick={loadGcal}>Actualizar</Button>
                </Box>
            </Paper>

            <Paper sx={{ p: 2.5, mb: 3 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                    <Typography variant="h6">Píxel de Meta</Typography>
                    {pixel.verificacion?.ok && <Chip size="small" color="success" label="Verificado" />}
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Cuando un lead pasa a una etapa de cierre, el CRM le avisa al píxel que esa
                    persona compró. Así las campañas aprenden a buscar gente parecida a la que
                    realmente compra, y no solo a la que escribe.
                </Typography>

                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <TextField
                        size="small" label="ID del píxel" value={pixelId}
                        onChange={(e) => setPixelId(e.target.value.replace(/[^0-9]/g, ''))}
                        sx={{ minWidth: 220 }}
                    />
                    <TextField
                        size="small" label="Token propio (opcional)" value={pixelToken} type="password"
                        onChange={(e) => setPixelToken(e.target.value)}
                        placeholder={pixel.token_propio ? 'Ya hay uno cargado' : 'Se usa el de la conexión'}
                        sx={{ minWidth: 240 }}
                    />
                    <Button variant="contained" disabled={pixelBusy} onClick={guardarPixel}>Guardar</Button>
                    <Button disabled={pixelBusy} onClick={buscarPixeles}>Buscar píxeles</Button>
                </Box>

                {pixelOpciones.length > 0 && (
                    <Box sx={{ mt: 2 }}>
                        <Typography variant="caption" color="text.secondary">
                            Elegí el píxel de esta empresa. Fijate en la cuenta publicitaria: el token
                            puede ver píxeles de otras cuentas.
                        </Typography>
                        {pixelOpciones.map((p: any) => (
                            <Box key={p.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                                <Box sx={{ flex: 1 }}>
                                    <Typography variant="body2">{p.name}</Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        {p.cuenta} · {p.id}
                                        {p.last_fired_time ? ` · último evento ${new Date(p.last_fired_time).toLocaleString('es-AR')}` : ' · sin eventos'}
                                    </Typography>
                                </Box>
                                <Button size="small" onClick={() => setPixelId(p.id)}>Usar este</Button>
                            </Box>
                        ))}
                    </Box>
                )}

                {pixel.pixel_id && (
                    <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                        <TextField
                            size="small" label="Código de prueba" value={pixelTestCode}
                            onChange={(e) => setPixelTestCode(e.target.value)}
                            helperText='Events Manager → Eventos de prueba (ej: TEST12345)'
                            sx={{ minWidth: 220 }}
                        />
                        <Button disabled={pixelBusy || !pixelTestCode.trim()} onClick={probarPixel}>
                            Enviar evento de prueba
                        </Button>
                    </Box>
                )}

                {pixel.verificacion && !pixel.verificacion.ok && (
                    <Typography variant="body2" sx={{ color: 'warning.main', mt: 2 }}>
                        {pixel.verificacion.detail}
                    </Typography>
                )}
            </Paper>

            <TableContainer component={Paper}>
                <Table>
                    <TableHead>
                        <TableRow>
                            <TableCell>Nombre</TableCell>
                            <TableCell>URL</TableCell>
                            <TableCell>Evento</TableCell>
                            <TableCell>Estado</TableCell>
                            <TableCell>Acciones</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {webhooks.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} align="center">
                                    No hay webhooks configurados. Crea uno para empezar.
                                </TableCell>
                            </TableRow>
                        ) : (
                            webhooks.map((webhook) => (
                                <TableRow key={webhook.id}>
                                    <TableCell>{webhook.name}</TableCell>
                                    <TableCell>
                                        <Typography variant="body2" noWrap sx={{ maxWidth: 300 }}>
                                            {webhook.url}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        <Chip
                                            label={eventOptions.find(e => e.value === webhook.event)?.label}
                                            size="small"
                                            color="primary"
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <Chip
                                            label={webhook.active ? 'Activo' : 'Inactivo'}
                                            size="small"
                                            color={webhook.active ? 'success' : 'default'}
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <IconButton onClick={() => handleOpen(webhook)} size="small">
                                            <EditIcon />
                                        </IconButton>
                                        <IconButton onClick={() => handleDelete(webhook.id)} size="small" color="error">
                                            <DeleteIcon />
                                        </IconButton>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
            </TableContainer>

            <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
                <DialogTitle>
                    {editingWebhook ? 'Editar Webhook' : 'Nuevo Webhook'}
                </DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}>
                        <TextField
                            label="Nombre"
                            fullWidth
                            value={formData.name}
                            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                            required
                        />
                        <TextField
                            label="URL del Webhook"
                            fullWidth
                            value={formData.url}
                            onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                            placeholder="https://n8n.tu-dominio.com/webhook/..."
                            required
                        />
                        <FormControl fullWidth>
                            <InputLabel>Evento a Escuchar</InputLabel>
                            <Select
                                value={formData.event}
                                label="Evento a Escuchar"
                                onChange={(e) => setFormData({ ...formData, event: e.target.value })}
                            >
                                {eventOptions.map((option) => (
                                    <MenuItem key={option.value} value={option.value}>
                                        {option.label}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <TextField
                            label="Descripción (opcional)"
                            fullWidth
                            multiline
                            rows={2}
                            value={formData.description}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        />
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={formData.active}
                                    onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
                                />
                            }
                            label="Webhook Activo"
                        />
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleClose}>Cancelar</Button>
                    <Button onClick={handleSave} variant="contained">
                        {editingWebhook ? 'Actualizar' : 'Crear'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};

export default Integrations;
