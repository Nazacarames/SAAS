SELECT c.id, c.name, c.number,
       EXISTS(
         SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct."tagId"
         WHERE ct."contactId"=c.id AND t.name='enviado_tokko'
       ) AS enviado_tokko,
       (SELECT COUNT(*) FROM messages m WHERE m."contactId"=c.id AND m."fromMe"=true) AS out_msgs,
       (SELECT status FROM tickets tt WHERE tt."contactId"=c.id ORDER BY id DESC LIMIT 1) AS ticket_status
FROM contacts c
WHERE c.id IN (51,52)
ORDER BY c.id;
