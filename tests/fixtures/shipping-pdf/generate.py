"""Synthetic shipping labels only; no customer or paid-postage data."""
from io import BytesIO
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.graphics.barcode import code128
from pypdf import PdfReader, PdfWriter
from pypdf.constants import UserAccessPermissions as P
from pypdf.generic import RectangleObject

root = Path(__file__).parent

def make(name, sizes, permission=P.PRINT | P.PRINT_TO_REPRESENTATION, password='', crop=False, rotate=False):
    content = BytesIO()
    sheet = canvas.Canvas(content, pagesize=sizes[0], invariant=1)
    for number, size in enumerate(sizes, 1):
        sheet.setPageSize(size)
        sheet.setFont('Helvetica-Bold', 16)
        sheet.drawString(20, size[1]-35, f'TEST LABEL {number}')
        sheet.setFont('Helvetica', 10)
        sheet.drawString(20, size[1]-60, 'Synthetic test - not valid postage')
        code128.Code128(f'TESTSHIP000{number}', barHeight=60, barWidth=1).drawOn(sheet, 20, 70)
        sheet.drawString(20, 45, f'TESTSHIP000{number}')
        sheet.showPage()
    sheet.save()
    writer = PdfWriter()
    writer.append(PdfReader(BytesIO(content.getvalue())))
    if crop:
        writer.pages[0].cropbox = RectangleObject([0,0,288,432])
    if rotate:
        writer.pages[-1].rotate(90)
    writer.encrypt(user_password=password, owner_password='synthetic-owner-only', permissions_flag=permission, algorithm='AES-128')
    with (root / name).open('wb') as out:
        writer.write(out)

make('printable-restricted.pdf', [(288,432),(288,432)], rotate=True)
make('password-required.pdf', [(288,432)], password='synthetic-open-password')
make('printing-disabled.pdf', [(288,432)], permission=P(0))
make('low-resolution-only.pdf', [(288,432)], permission=P.PRINT)
make('letter-cropped.pdf', [(612,792)], crop=True)
