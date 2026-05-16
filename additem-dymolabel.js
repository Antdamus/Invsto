// dymo.js
window.dymoModule = (function () {
    const WEBSITE_QR_URL = "https://www.og-jewelers.com/";

    //check barcode uniqueness
    async function barcodeExists(barcode) {
        const { data, error } = await supabase
            .from("item_types")
            .select("id")
            .eq("barcode", barcode)
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error("❌ Barcode existence check error:", error.message);
            throw error;
        }

        return !!data; // true if barcode exists
    }

    //ensure the dymo label already does not exist
    async function dymoLabelExists(labelPath) {
        const { data, error } = await supabase
            .from("item_types")
            .select("id")
            .eq("dymo_label_url", labelPath)
            .limit(1)
            .maybeSingle(); // ✅ allows 0 rows without error

        if (error) {
            console.error("❌ DYMO label existence check error:", error.message);
            throw error;
        }

        return !!data; // true if label exists
    }

    //generate the dymo label
    async function generateAndUploadDymoLabel({ barcode, qr, price, typeqr }) {
        // generate XML,this rewrites the actual file
        const templateXml = `<?xml version="1.0" encoding="utf-8"?>
        <DesktopLabel Version="1">
        <DYMOLabel Version="4">
            <Description>DYMO Label</Description>
            <Orientation>Portrait</Orientation>
            <LabelName>Jewelry30299</LabelName>
            <InitialLength>0</InitialLength>
            <BorderStyle>SolidLine</BorderStyle>
            <DYMORect>
            <DYMOPoint>
                <X>0.040000137</X>
                <Y>0.060000002</Y>
            </DYMOPoint>
            <Size>
                <Width>2.0433333</Width>
                <Height>0.75666666</Height>
            </Size>
            </DYMORect>
            <BorderColor>
            <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
            </SolidColorBrush>
            </BorderColor>
            <BorderThickness>1</BorderThickness>
            <Show_Border>False</Show_Border>
            <HasFixedLength>False</HasFixedLength>
            <FixedLengthValue>0</FixedLengthValue>
            <DynamicLayoutManager>
            <RotationBehavior>ClearObjects</RotationBehavior>
            <LabelObjects>
                <QRCodeObject>
                <Name>QRCodeObject0</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="1" R="1" G="1" B="1"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation0</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <BarcodeFormat>QRCode</BarcodeFormat>
                <Data>
                    <DataString>${qr}</DataString>
                </Data>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Middle</VerticalAlignment>
                <Size>AutoFit</Size>
                <EQRCodeType>QRCodeText</EQRCodeType>
                <TextDataHolder>
                    <Value>${qr}</Value>
                </TextDataHolder>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>1.5044161</X>
                    <Y>0.06538457</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.28525865</Width>
                    <Height>0.32408708</Height>
                    </Size>
                </ObjectLayout>
                </QRCodeObject>
                <QRCodeObject>
                <Name>QRCodeObject1</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="1" R="1" G="1" B="1"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation0</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <BarcodeFormat>QRCode</BarcodeFormat>
                <Data>
                    <DataString>${qr}</DataString>
                </Data>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Middle</VerticalAlignment>
                <Size>AutoFit</Size>
                <EQRCodeType>QRCodeText</EQRCodeType>
                <TextDataHolder>
                    <Value>${qr}</Value>
                </TextDataHolder>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>1.5044161</X>
                    <Y>0.47906214</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.3110023</Width>
                    <Height>0.29687557</Height>
                    </Size>
                </ObjectLayout>
                </QRCodeObject>
                <TextObject>
                <Name>TextObject0</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation90</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Bottom</VerticalAlignment>
                <FitMode>None</FitMode>
                <IsVertical>False</IsVertical>
                <FormattedText>
                    <FitMode>None</FitMode>
                    <HorizontalAlignment>Center</HorizontalAlignment>
                    <VerticalAlignment>Bottom</VerticalAlignment>
                    <IsVertical>False</IsVertical>
                    <LineTextSpan>
                    <TextSpan>
                        <Text>${price}g</Text>
                        <FontInfo>
                        <FontName>Segoe UI</FontName>
                        <FontSize>6</FontSize>
                        <IsBold>False</IsBold>
                        <IsItalic>False</IsItalic>
                        <IsUnderline>False</IsUnderline>
                        <FontBrush>
                            <SolidColorBrush>
                            <Color A="1" R="0" G="0" B="0"></Color>
                            </SolidColorBrush>
                        </FontBrush>
                        </FontInfo>
                    </TextSpan>
                    </LineTextSpan>
                </FormattedText>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>1.8935279</X>
                    <Y>0.06538457</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.125</Width>
                    <Height>0.36014307</Height>
                    </Size>
                </ObjectLayout>
                </TextObject>
                <TextObject>
                <Name>TextObject1</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation90</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Bottom</VerticalAlignment>
                <FitMode>None</FitMode>
                <IsVertical>False</IsVertical>
                <FormattedText>
                    <FitMode>None</FitMode>
                    <HorizontalAlignment>Center</HorizontalAlignment>
                    <VerticalAlignment>Bottom</VerticalAlignment>
                    <IsVertical>False</IsVertical>
                    <LineTextSpan>
                    <TextSpan>
                        <Text>${price}g</Text>
                        <FontInfo>
                        <FontName>Segoe UI</FontName>
                        <FontSize>6</FontSize>
                        <IsBold>False</IsBold>
                        <IsItalic>False</IsItalic>
                        <IsUnderline>False</IsUnderline>
                        <FontBrush>
                            <SolidColorBrush>
                            <Color A="1" R="0" G="0" B="0"></Color>
                            </SolidColorBrush>
                        </FontBrush>
                        </FontInfo>
                    </TextSpan>
                    </LineTextSpan>
                </FormattedText>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>1.9046868</X>
                    <Y>0.43833333</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.125</Width>
                    <Height>0.3783332</Height>
                    </Size>
                </ObjectLayout>
                </TextObject>
                <TextObject>
                <Name>TextObject2</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation90</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Bottom</VerticalAlignment>
                <FitMode>None</FitMode>
                <IsVertical>False</IsVertical>
                <FormattedText>
                    <FitMode>None</FitMode>
                    <HorizontalAlignment>Center</HorizontalAlignment>
                    <VerticalAlignment>Bottom</VerticalAlignment>
                    <IsVertical>False</IsVertical>
                    <LineTextSpan>
                    <TextSpan>
                        <Text>${typeqr}</Text>
                        <FontInfo>
                        <FontName>Segoe UI</FontName>
                        <FontSize>4</FontSize>
                        <IsBold>False</IsBold>
                        <IsItalic>False</IsItalic>
                        <IsUnderline>False</IsUnderline>
                        <FontBrush>
                            <SolidColorBrush>
                            <Color A="1" R="0" G="0" B="0"></Color>
                            </SolidColorBrush>
                        </FontBrush>
                        </FontInfo>
                    </TextSpan>
                    </LineTextSpan>
                </FormattedText>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>1.4095135</X>
                    <Y>0.059999704</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.12500004</Width>
                    <Height>0.3783333</Height>
                    </Size>
                </ObjectLayout>
                </TextObject>
                <TextObject>
                <Name>TextObject3</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation90</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Bottom</VerticalAlignment>
                <FitMode>None</FitMode>
                <IsVertical>False</IsVertical>
                <FormattedText>
                    <FitMode>None</FitMode>
                    <HorizontalAlignment>Center</HorizontalAlignment>
                    <VerticalAlignment>Bottom</VerticalAlignment>
                    <IsVertical>False</IsVertical>
                    <LineTextSpan>
                    <TextSpan>
                        <Text>${typeqr}</Text>
                        <FontInfo>
                        <FontName>Segoe UI</FontName>
                        <FontSize>4</FontSize>
                        <IsBold>False</IsBold>
                        <IsItalic>False</IsItalic>
                        <IsUnderline>False</IsUnderline>
                        <FontBrush>
                            <SolidColorBrush>
                            <Color A="1" R="0" G="0" B="0"></Color>
                            </SolidColorBrush>
                        </FontBrush>
                        </FontInfo>
                    </TextSpan>
                    </LineTextSpan>
                </FormattedText>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>1.4095135</X>
                    <Y>0.43833333</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.125</Width>
                    <Height>0.3783333</Height>
                    </Size>
                </ObjectLayout>
                </TextObject>
                <QRCodeObject>
                <Name>QRCodeObject2</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="1" R="1" G="1" B="1"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation0</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <BarcodeFormat>QRCode</BarcodeFormat>
                <Data>
                    <DataString>${barcode}</DataString>
                </Data>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Middle</VerticalAlignment>
                <Size>AutoFit</Size>
                <EQRCodeType>QRCodeText</EQRCodeType>
                <TextDataHolder>
                    <Value>${barcode}</Value>
                </TextDataHolder>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>0.26554355</X>
                    <Y>0.47743064</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.30536497</Width>
                    <Height>0.30013865</Height>
                    </Size>
                </ObjectLayout>
                </QRCodeObject>
                <QRCodeObject>
                <Name>QRCodeObject3</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="1" R="1" G="1" B="1"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation0</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <BarcodeFormat>QRCode</BarcodeFormat>
                <Data>
                    <DataString>${barcode}</DataString>
                </Data>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Middle</VerticalAlignment>
                <Size>AutoFit</Size>
                <EQRCodeType>QRCodeText</EQRCodeType>
                <TextDataHolder>
                    <Value>${barcode}</Value>
                </TextDataHolder>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>0.2628106</X>
                    <Y>0.09862068</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.308098</Width>
                    <Height>0.290851</Height>
                    </Size>
                </ObjectLayout>
                </QRCodeObject>
                <TextObject>
                <Name>TextObject4</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation90</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Bottom</VerticalAlignment>
                <FitMode>None</FitMode>
                <IsVertical>False</IsVertical>
                <FormattedText>
                    <FitMode>None</FitMode>
                    <HorizontalAlignment>Center</HorizontalAlignment>
                    <VerticalAlignment>Bottom</VerticalAlignment>
                    <IsVertical>False</IsVertical>
                    <LineTextSpan>
                    <TextSpan>
                        <Text>barcode</Text>
                        <FontInfo>
                        <FontName>Segoe UI</FontName>
                        <FontSize>4</FontSize>
                        <IsBold>False</IsBold>
                        <IsItalic>False</IsItalic>
                        <IsUnderline>False</IsUnderline>
                        <FontBrush>
                            <SolidColorBrush>
                            <Color A="1" R="0" G="0" B="0"></Color>
                            </SolidColorBrush>
                        </FontBrush>
                        </FontInfo>
                    </TextSpan>
                    </LineTextSpan>
                </FormattedText>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>0.13781057</X>
                    <Y>0.05999986</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.12500001</Width>
                    <Height>0.3783335</Height>
                    </Size>
                </ObjectLayout>
                </TextObject>
                <TextObject>
                <Name>TextObject5</Name>
                <Brushes>
                    <BackgroundBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                    <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                    <SolidColorBrush>
                        <Color A="0" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                    </FillBrush>
                </Brushes>
                <Rotation>Rotation90</Rotation>
                <OutlineThickness>1</OutlineThickness>
                <IsOutlined>False</IsOutlined>
                <BorderStyle>SolidLine</BorderStyle>
                <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                </Margin>
                <HorizontalAlignment>Center</HorizontalAlignment>
                <VerticalAlignment>Bottom</VerticalAlignment>
                <FitMode>None</FitMode>
                <IsVertical>False</IsVertical>
                <FormattedText>
                    <FitMode>None</FitMode>
                    <HorizontalAlignment>Center</HorizontalAlignment>
                    <VerticalAlignment>Bottom</VerticalAlignment>
                    <IsVertical>False</IsVertical>
                    <LineTextSpan>
                    <TextSpan>
                        <Text>barcode</Text>
                        <FontInfo>
                        <FontName>Segoe UI</FontName>
                        <FontSize>4</FontSize>
                        <IsBold>False</IsBold>
                        <IsItalic>False</IsItalic>
                        <IsUnderline>False</IsUnderline>
                        <FontBrush>
                            <SolidColorBrush>
                            <Color A="1" R="0" G="0" B="0"></Color>
                            </SolidColorBrush>
                        </FontBrush>
                        </FontInfo>
                    </TextSpan>
                    </LineTextSpan>
                </FormattedText>
                <ObjectLayout>
                    <DYMOPoint>
                    <X>0.13781057</X>
                    <Y>0.43833315</Y>
                    </DYMOPoint>
                    <Size>
                    <Width>0.12500001</Width>
                    <Height>0.378334</Height>
                    </Size>
                </ObjectLayout>
                </TextObject>
            </LabelObjects>
            </DynamicLayoutManager>
        </DYMOLabel>
        <LabelApplication>Blank</LabelApplication>
        <DataTable>
            <Columns></Columns>
            <Rows></Rows>
        </DataTable>
        </DesktopLabel>`;

        //create the label path
        const labelPath = `labels/${Date.now()}_OGJewelryLabel.dymo`;

        // Check if a DYMO label already exists with same path
        const exists = await dymoLabelExists(labelPath);
        if (exists) throw new Error(`DYMO label path "${labelPath}" already exists.`);

        // ✅ Do not upload here — just return XML + path
        return { templateXml, labelPath };

    }

    function setDymoStatus(message) {
        const statusEl = document.getElementById("dymo-status");
        if (statusEl) statusEl.innerText = message || "";
    }

    function clearPendingDymoLabel(options = {}) {
        window.latestDymoXml = "";
        window.latestDymoUrl = "";
        window.latestDymoBarcode = "";
        window.latestDymoGeneratedAt = "";

        if (options.statusMessage !== undefined) {
            setDymoStatus(options.statusMessage);
        }
    }

    function getPreparedDymoLabel() {
        return {
            xml: window.latestDymoXml || "",
            url: window.latestDymoUrl || "",
            barcode: window.latestDymoBarcode || "",
            generatedAt: window.latestDymoGeneratedAt || "",
        };
    }

    function makeSafeDymoDownloadName(barcode) {
        const safeBarcode = String(barcode || "OGJewelryLabel")
            .trim()
            .replace(/[^\w.-]+/g, "_")
            .replace(/^_+|_+$/g, "");
        return `${safeBarcode || "OGJewelryLabel"}.dymo`;
    }

    function downloadPreparedDymoLabel(filename = "") {
        if (!window.latestDymoXml) {
            throw new Error("No DYMO label is ready to download.");
        }

        const blob = new Blob([window.latestDymoXml], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename || makeSafeDymoDownloadName(window.latestDymoBarcode);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function getDymoFramework() {
        return window.dymo?.label?.framework || null;
    }

    function normalizeDymoPrinters(printers) {
        if (!printers) return [];
        if (Array.isArray(printers)) return printers.filter(Boolean);

        if (typeof printers.length === "number") {
            const list = [];
            for (let index = 0; index < printers.length; index += 1) {
                const printer = typeof printers.item === "function" ? printers.item(index) : printers[index];
                if (printer) list.push(printer);
            }
            if (list.length) return list;
        }

        return Object.keys(printers)
            .map((key) => printers[key])
            .filter((printer) => printer && typeof printer === "object" && printer.name);
    }

    async function ensureDymoFrameworkReady() {
        const framework = getDymoFramework();
        if (!framework) {
            throw new Error("DYMO Connect is not available in this browser. Make sure DYMO Connect/Web Service is running.");
        }

        if (typeof framework.init !== "function") return framework;

        await new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve();
            }, 3500);

            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve();
            };

            try {
                const initResult = framework.init(finish);
                if (initResult && typeof initResult.then === "function") {
                    initResult.then(finish).catch((error) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timeout);
                        reject(error);
                    });
                }
            } catch (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            }
        });

        return framework;
    }

    async function printDymoLabelXml(labelXml, options = {}) {
        const copies = Math.max(1, Math.floor(Number(options.copies) || 1));
        const preferredPrinterName = String(options.printerName || "").trim();
        const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
        const framework = await ensureDymoFrameworkReady();

        if (typeof framework.getPrinters !== "function" || typeof framework.openLabelXml !== "function") {
            throw new Error("DYMO Connect print functions are not available.");
        }

        const printers = normalizeDymoPrinters(framework.getPrinters());
        const printer = printers.find((entry) => preferredPrinterName && entry.name === preferredPrinterName)
            || printers.find((entry) => /labelwriter/i.test(`${entry.printerType || ""} ${entry.modelName || ""} ${entry.name || ""}`))
            || printers[0];

        if (!printer?.name) {
            throw new Error("No DYMO printer was found. Open DYMO Connect and confirm the printer is available.");
        }

        const label = framework.openLabelXml(labelXml);
        if (!label || typeof label.print !== "function") {
            throw new Error("The DYMO label could not be opened for printing.");
        }

        for (let index = 0; index < copies; index += 1) {
            onProgress?.(index + 1, copies, printer);
            label.print(printer.name);
            // Give DYMO Connect a small breath between jobs so larger batches do not get dropped.
            await new Promise((resolve) => setTimeout(resolve, 120));
        }

        return { printerName: printer.name, copies };
    }

    async function printPreparedDymoLabel(options = {}) {
        if (!window.latestDymoXml) {
            throw new Error("No DYMO label is ready to print.");
        }
        return printDymoLabelXml(window.latestDymoXml, options);
    }

    async function generateDymoLabelFromForm(options = {}) {
        const { downloadPreview = true, silent = false } = options;
        const barcodeEl = document.getElementById("scanned-barcode");
        const qrEl = document.getElementById("qr-code");
        const qrTypeEl = document.getElementById("qr-type");
        const statusEl = document.getElementById("dymo-status");
        const barcode = barcodeEl?.value || "OG" + Date.now();
        const effectiveQrType = qrTypeEl?.value || (typeof typeqr !== "undefined" ? typeqr : "website");

        const exists = await dymoModule.barcodeExists(barcode);
        if (exists) {
            const message = `Barcode "${barcode}" already exists in inventory. Please generate a new one.`;
            if (!silent) alert(`❌ ${message}`);
            throw new Error(message);
        }

        const qr = qrEl?.value?.trim() || (
            effectiveQrType === "website"
                ? WEBSITE_QR_URL
                : "https://ogjewelry.store/auth?id=" + barcode
        );
        const price = document.getElementById("weight")?.value?.trim() || "0.0";

        const { templateXml, labelPath } = await dymoModule.generateAndUploadDymoLabel({
            barcode,
            qr,
            price,
            typeqr: effectiveQrType,
        });

        if (downloadPreview) {
            const blob = new Blob([templateXml], { type: "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "OGJewelryLabel.dymo";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        window.latestDymoXml = templateXml;
        window.latestDymoUrl = labelPath;
        window.latestDymoBarcode = barcode;
        window.latestDymoGeneratedAt = new Date().toISOString();

        console.log(`✅ DYMO label generated, path reserved: ${labelPath}`);
        if (statusEl) {
            statusEl.innerText = downloadPreview
                ? "✅ DYMO label generated for preview. It will be saved after the item is added."
                : "✅ DYMO label staged. It will be saved only after the item is added.";
        }

        return { templateXml, labelPath };
    }

    //set up the event listener 
    function setupGenerateDymoButtonListener() {
        const button = document.getElementById("generate-dymo-label");
        if (!button) {
            console.error("❌ generate-dymo-label button not found!");
            return;
        }

        button.addEventListener("click", async () => {
            try {
                await generateDymoLabelFromForm({ downloadPreview: false });
            } catch (err) {
                console.error("❌ DYMO generation failed:", err);
                alert(`DYMO generation failed: ${err.message || err}`);
            }
        });
    }

    // In additem-dymolabel.js, inside window.dymoModule = (function() { ... }) block
    async function uploadFinalDymoLabel(options = {}) {
        const expectedBarcode = String(options.expectedBarcode || "").trim();
        const skipItemPathCheck = options.skipItemPathCheck === true;
        if (!window.latestDymoXml || !window.latestDymoUrl) {
            throw new Error("No DYMO label generated. Please generate it first before submitting.");
        }

        if (expectedBarcode && window.latestDymoBarcode && window.latestDymoBarcode !== expectedBarcode) {
            throw new Error(`The staged DYMO label is for barcode "${window.latestDymoBarcode}", not "${expectedBarcode}". Please regenerate it.`);
        }

        const blob = new Blob([window.latestDymoXml], { type: "application/octet-stream" });

        if (!skipItemPathCheck) {
            const exists = await dymoModule.dymoLabelExists(window.latestDymoUrl);
            if (exists) {
                throw new Error(`DYMO label path "${window.latestDymoUrl}" already exists.`);
            }
        }

        const { error: uploadError } = await supabase
            .storage
            .from("dymo-labels")
            .upload(window.latestDymoUrl, blob, {
                upsert: true,
                contentType: "application/octet-stream",
            });

        if (uploadError) throw uploadError;

        console.log(`✅ DYMO label uploaded to ${window.latestDymoUrl}`);
        return window.latestDymoUrl;
    }

  return { 
    generateAndUploadDymoLabel, 
    generateDymoLabelFromForm,
    barcodeExists, 
    dymoLabelExists, 
    setupGenerateDymoButtonListener, 
    uploadFinalDymoLabel,
    clearPendingDymoLabel,
    getPreparedDymoLabel,
    downloadPreparedDymoLabel,
    makeSafeDymoDownloadName,
    printDymoLabelXml,
    printPreparedDymoLabel,
};
})();
