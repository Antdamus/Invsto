(function () {
  "use strict";
  // Short bag IDs keep tiny 30299 tags readable and uniquely identify repeat auctions.
  // Scan either end in Invsto's bag lookup. Never use the eBay tile's list ordinal.
  const clip = value => value.length > 18 ? value.slice(0, 15) + "..." : value;
  function identity(lot, auction) {
    const reference = auction?.listing_title?.match(/^#([A-Za-z0-9_-]+)/)?.[1];
    return { auctionNumber: reference || (auction ? "" : lot.auction_number), lotCode: lot.lot_code,
      freeText: auction?.buyer || "", title: auction?.listing_title || `Auction ${lot.auction_number}` };
  }
  function url(code) { return `bag-lookup.html?bag=${encodeURIComponent(code)}`; }
function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function qrObject(name, value, x, y, width, height) {
  const safe = escapeXml(value);
  return `
    <QRCodeObject>
      <Name>${name}</Name>
      <Brushes>
        <BackgroundBrush><SolidColorBrush><Color A="1" R="1" G="1" B="1"></Color></SolidColorBrush></BackgroundBrush>
        <BorderBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderBrush>
        <StrokeBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></StrokeBrush>
        <FillBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></FillBrush>
      </Brushes>
      <Rotation>Rotation0</Rotation>
      <OutlineThickness>1</OutlineThickness>
      <IsOutlined>False</IsOutlined>
      <BorderStyle>SolidLine</BorderStyle>
      <Margin><DYMOThickness Left="0" Top="0" Right="0" Bottom="0" /></Margin>
      <BarcodeFormat>QRCode</BarcodeFormat>
      <Data><DataString>${safe}</DataString></Data>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Middle</VerticalAlignment>
      <Size>AutoFit</Size>
      <EQRCodeType>QRCodeText</EQRCodeType>
      <TextDataHolder><Value>${safe}</Value></TextDataHolder>
      <ObjectLayout>
        <DYMOPoint><X>${x}</X><Y>${y}</Y></DYMOPoint>
        <Size><Width>${width}</Width><Height>${height}</Height></Size>
      </ObjectLayout>
    </QRCodeObject>
  `;
}

function textObject(name, value, x, y, fontSize = "4") {
  const safe = escapeXml(value);
  return `
    <TextObject>
      <Name>${name}</Name>
      <Brushes>
        <BackgroundBrush><SolidColorBrush><Color A="0" R="0" G="0" B="0"></Color></SolidColorBrush></BackgroundBrush>
        <BorderBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderBrush>
        <StrokeBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></StrokeBrush>
        <FillBrush><SolidColorBrush><Color A="0" R="0" G="0" B="0"></Color></SolidColorBrush></FillBrush>
      </Brushes>
      <Rotation>Rotation90</Rotation>
      <OutlineThickness>1</OutlineThickness>
      <IsOutlined>False</IsOutlined>
      <BorderStyle>SolidLine</BorderStyle>
      <Margin><DYMOThickness Left="0" Top="0" Right="0" Bottom="0" /></Margin>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Bottom</VerticalAlignment>
      <FitMode>AlwaysFit</FitMode>
      <IsVertical>False</IsVertical>
      <FormattedText>
        <FitMode>AlwaysFit</FitMode>
        <HorizontalAlignment>Center</HorizontalAlignment>
        <VerticalAlignment>Bottom</VerticalAlignment>
        <IsVertical>False</IsVertical>
        <LineTextSpan>
          <TextSpan>
            <Text>${safe}</Text>
            <FontInfo>
              <FontName>Segoe UI</FontName>
              <FontSize>${fontSize}</FontSize>
              <IsBold>True</IsBold>
              <IsItalic>False</IsItalic>
              <IsUnderline>False</IsUnderline>
              <FontBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></FontBrush>
            </FontInfo>
          </TextSpan>
        </LineTextSpan>
      </FormattedText>
      <ObjectLayout>
        <DYMOPoint><X>${x}</X><Y>${y}</Y></DYMOPoint>
        <Size><Width>0.12500001</Width><Height>0.378334</Height></Size>
      </ObjectLayout>
    </TextObject>
  `;
}

function buildLiveAuctionDymoXml({ auctionNumber, lotCode, freeText }) {
  const auctionValue = String(auctionNumber || "").trim();
  const lotValue = String(lotCode || "").trim();
  if (!lotValue) throw new Error("This bag has no label ID. Reload the bag and try again.");
  const rightText = clip(String(freeText || "WINNER NOT SET").trim().toUpperCase());
  const leftText = clip(auctionValue ? `#${auctionValue.replace(/^#/, "")}` : "EBAY SALE");

  return `<?xml version="1.0" encoding="utf-8"?>
<DesktopLabel Version="1">
  <DYMOLabel Version="4">
    <Description>DYMO Label</Description>
    <Orientation>Portrait</Orientation>
    <LabelName>Jewelry30299</LabelName>
    <InitialLength>0</InitialLength>
    <BorderStyle>SolidLine</BorderStyle>
    <DYMORect>
      <DYMOPoint><X>0.040000137</X><Y>0.060000002</Y></DYMOPoint>
      <Size><Width>2.0433333</Width><Height>0.75666666</Height></Size>
    </DYMORect>
    <BorderColor><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderColor>
    <BorderThickness>1</BorderThickness>
    <Show_Border>False</Show_Border>
    <HasFixedLength>False</HasFixedLength>
    <FixedLengthValue>0</FixedLengthValue>
    <DynamicLayoutManager>
      <RotationBehavior>ClearObjects</RotationBehavior>
      <LabelObjects>
        ${qrObject("QRCodeObject0", lotValue, "1.5044161", "0.06538457", "0.28525865", "0.32408708")}
        ${qrObject("QRCodeObject1", lotValue, "1.5044161", "0.47906214", "0.3110023", "0.29687557")}
        ${textObject("TextObject0", rightText, "1.4095135", "0.059999704", "4.8")}
        ${textObject("TextObject1", rightText, "1.4095135", "0.43833333", "4.8")}
        ${qrObject("QRCodeObject2", lotValue, "0.26554355", "0.47743064", "0.30536497", "0.30013865")}
        ${qrObject("QRCodeObject3", lotValue, "0.2628106", "0.09862068", "0.308098", "0.290851")}
        ${textObject("TextObject4", leftText, "0.13781057", "0.059999704", "4")}
        ${textObject("TextObject5", leftText, "0.13781057", "0.43833315", "4")}
      </LabelObjects>
    </DynamicLayoutManager>
  </DYMOLabel>
  <LabelApplication>Blank</LabelApplication>
  <DataTable><Columns></Columns><Rows></Rows></DataTable>
</DesktopLabel>`;
}

  window.liveBagLabel = { build: buildLiveAuctionDymoXml, identity, url };
})();
