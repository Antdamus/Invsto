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

        console.log(`✅ DYMO label generated, path reserved: ${labelPath}`);
        if (statusEl) {
            statusEl.innerText = downloadPreview
                ? "✅ DYMO label generated & ready for final upload."
                : "✅ DYMO label auto-generated & ready for final upload.";
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
                await generateDymoLabelFromForm({ downloadPreview: true });
                return;
                const barcode = barcodeInput.value || "OG" + Date.now();

                const exists = await dymoModule.barcodeExists(barcode);
                if (exists) {
                    alert(`❌ Barcode "${barcode}" already exists in inventory. Please generate a new one.`);
                    return;
                }

                const qr = qrInput.value.trim() || (
                    typeqr === "website"
                        ? WEBSITE_QR_URL
                        : "https://ogjewelry.store/auth?id=" + barcode
                );
                const price = document.getElementById("weight").value?.trim() || "0.0"; // pass weight as price

                const { templateXml, labelPath } = await dymoModule.generateAndUploadDymoLabel({
                    barcode, qr, price, typeqr,
                });

                // ✅ Download label locally for preview only
                const blob = new Blob([templateXml], { type: "application/octet-stream" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "OGJewelryLabel.dymo";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                // ✅ Save XML and reserved path for later upload on final submit
                window.latestDymoXml = templateXml;
                window.latestDymoUrl = labelPath;

                console.log(`✅ DYMO label generated, path reserved: ${labelPath}`);
                document.getElementById("dymo-status").innerText =
                    "✅ DYMO label generated & ready for final upload.";

            } catch (err) {
                console.error("❌ DYMO generation failed:", err);
                alert(`DYMO generation failed: ${err.message || err}`);
            }
        });
    }

    // In additem-dymolabel.js, inside window.dymoModule = (function() { ... }) block
    async function uploadFinalDymoLabel() {
        if (!window.latestDymoXml || !window.latestDymoUrl) {
            throw new Error("No DYMO label generated. Please generate it first before submitting.");
        }

        const blob = new Blob([window.latestDymoXml], { type: "application/octet-stream" });

        const exists = await dymoModule.dymoLabelExists(window.latestDymoUrl);
        if (exists) {
            throw new Error(`DYMO label path "${window.latestDymoUrl}" already exists.`);
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
    uploadFinalDymoLabel 
};
})();
