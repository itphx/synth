[ATTACHMENTS NOT DELIVERED]

Some attachments were not delivered with the message:
{items}

Reasons: `modality` — the model does not accept this file type; `limit` — the attachment volume limit was exceeded; `unavailable` — the attachment object is unavailable.
Files listed with a path were saved in the project working directory: read text files with `read_file`, and for PDF, images, audio and video attach the file to the dialog with `attach_workspace_file` (it is delivered as an attachment and reaches the model on the next turn), or process it through the shell (`pdftotext`, OCR, `ffprobe`) when such tools are available. If the model does not support the format, tell the user about it.
