UPDATE kb_documents
SET content = REPLACE(REPLACE(REPLACE(content, 'Ubicaciones disponibles de Tokko (location tree):', 'Zonas disponibles:'), 'Tokko', 'Sistema'), 'location tree', 'zonas'),
    updated_at = NOW()
WHERE source_type = 'tokko_locations';
