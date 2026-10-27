[ATTACHMENTS NOT DELIVERED]

Some attachments were not delivered with the message:
{items}

Current model: {model} (accepts: {modalities}).
Reasons: `modality` — the model does not accept this file type; `limit` — the attachment volume limit was exceeded; `unavailable` — the attachment object is unavailable.
Do not attach these files again — the current model will drop them again and the turn will loop. Instead, tell the user that the attachment did not arrive and offer to: assign an auxiliary model for this modality (Settings → "Multimodal input", `modalityModels`) or send the text or a description of the content. If a text version of the file already exists in the project working directory (for example, extracted PDF text), it can be read with `read_file`.
