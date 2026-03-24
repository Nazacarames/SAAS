import { useEffect, useState } from 'react';
import {
  Typography, Box, Paper, Stack, Chip, Button, Select, MenuItem, FormControl, InputLabel, CircularProgress, Alert
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

interface MetaTemplate {
  id: string;
  name: string;
  status: string;
  language: string;
  category: string;
  components: string[];
}

const Templates = () => {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Meta templates
  const [templates, setTemplates] = useState<MetaTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [holaTemplateName, setHolaTemplateName] = useState('hola');
  const [holaTemplateLang, setHolaTemplateLang] = useState('es_AR');

  const availableLanguages = [
    { code: 'es_AR', label: 'Español (Argentina)' },
    { code: 'es_ES', label: 'Español (España)' },
    { code: 'en_US', label: 'English (US)' },
    { code: 'pt_BR', label: 'Português (Brasil)' },
    { code: 'es_MX', label: 'Español (México)' },
  ];

  const loadTemplates = async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const { data } = await api.get('/settings/meta/templates');
      if (data.error) {
        setTemplatesError(data.error === 'no_credentials' ? 'Configurá WhatsApp Cloud API primero en Configuración' : data.error);
        setTemplates([]);
      } else {
        setTemplates(data.templates || []);
      }
    } catch {
      setTemplatesError('Error al cargar templates');
    } finally {
      setTemplatesLoading(false);
    }
  };

  const load = async () => {
    try {
      const { data } = await api.get('/settings/whatsapp-cloud');
      const s = data?.settings || {};
      setHolaTemplateName(String(s.waFirstContactHolaTemplateName || 'hola'));
      setHolaTemplateLang(String(s.waFirstContactHolaTemplateLang || 'es_AR'));
    } catch { /* noop */ }
  };

  useEffect(() => { load(); loadTemplates(); }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await api.put('/settings/whatsapp-cloud', {
        waFirstContactHolaTemplateName: holaTemplateName,
        waFirstContactHolaTemplateLang: holaTemplateLang,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      toast.success('Template de bienvenida guardado');
    } catch {
      toast.error('Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Templates de Meta</Typography>

      <Stack spacing={3}>
        {/* TEMPLATE DE BIENVENIDA */}
        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Box>
              <Typography variant='h6'>Template de bienvenida</Typography>
              <Typography variant='body2' color='text.secondary'>
                Cuando llega un lead de Meta, se envía este template automáticamente para abrir la conversación.
              </Typography>
            </Box>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems='flex-start'>
              <FormControl size='small' sx={{ minWidth: 280 }}>
                <InputLabel>Template</InputLabel>
                <Select
                  value={holaTemplateName}
                  label='Template'
                  onChange={(e) => setHolaTemplateName(e.target.value)}
                >
                  {templates.filter(t => t.status === 'APPROVED').map((t) => (
                    <MenuItem key={t.id} value={t.name}>
                      <Stack direction='row' spacing={1} alignItems='center'>
                        <Typography>{t.name}</Typography>
                        <Chip size='small' label={t.language} />
                      </Stack>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl size='small' sx={{ minWidth: 220 }}>
                <InputLabel>Idioma</InputLabel>
                <Select
                  value={holaTemplateLang}
                  label='Idioma'
                  onChange={(e) => setHolaTemplateLang(e.target.value)}
                >
                  {availableLanguages.map((lang) => (
                    <MenuItem key={lang.code} value={lang.code}>{lang.label}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>

            <Alert severity='warning' sx={{ fontSize: '0.8rem' }}>
              El template debe tener una variable para el nombre del contacto y estar aprobado por Meta.
            </Alert>

            <Stack direction='row' spacing={1} alignItems='center'>
              <Button variant='contained' size='small' onClick={save} disabled={saving}>
                {saving ? 'Guardando…' : 'Guardar template'}
              </Button>
              {saved && <Chip size='small' color='success' label='Guardado' />}
            </Stack>
          </Stack>
        </Paper>

        {/* LISTA DE TEMPLATES */}
        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Stack direction='row' justifyContent='space-between' alignItems='center'>
              <Box>
                <Typography variant='h6'>Todos los templates</Typography>
                <Typography variant='body2' color='text.secondary'>
                  Templates disponibles en tu cuenta de WhatsApp Cloud API.
                </Typography>
              </Box>
              <Button variant='outlined' size='small' onClick={loadTemplates} disabled={templatesLoading}>
                Actualizar
              </Button>
            </Stack>

            {templatesLoading && <CircularProgress size={24} />}

            {templatesError && <Alert severity='error'>{templatesError}</Alert>}

            {!templatesLoading && !templatesError && templates.length === 0 && (
              <Alert severity='info'>No hay templates. Conectá WhatsApp Cloud API en Configuración.</Alert>
            )}

            <Stack spacing={1}>
              {templates.map((t) => (
                <Paper key={t.id} variant='outlined' sx={{ p: 1.5 }}>
                  <Stack direction='row' justifyContent='space-between' alignItems='center'>
                    <Box>
                      <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
                        <Typography variant='body2' fontWeight={600}>{t.name}</Typography>
                        <Chip size='small' label={t.language} />
                        <Chip size='small' color={
                          t.status === 'APPROVED' ? 'success' :
                          t.status === 'PENDING' ? 'warning' : 'default'
                        } label={t.status} />
                        <Chip size='small' variant='outlined' label={t.category} />
                      </Stack>
                      <Typography variant='caption' color='text.secondary'>
                        Componentes: {t.components.join(', ') || 'ninguno'}
                      </Typography>
                    </Box>
                    {t.name === holaTemplateName && (
                      <Chip size='small' color='primary' label='En uso' />
                    )}
                  </Stack>
                </Paper>
              ))}
            </Stack>
          </Stack>
        </Paper>
      </Stack>
    </Box>
  );
};

export default Templates;
