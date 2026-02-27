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
