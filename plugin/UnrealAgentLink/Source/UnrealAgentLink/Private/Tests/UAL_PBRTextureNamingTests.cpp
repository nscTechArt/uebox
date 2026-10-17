#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Utils/UAL_PBRMaterialHelper.h"
#include "Engine/Texture2D.h"
#include "Misc/Guid.h"
#include "UObject/Package.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FUALPBRTextureNamingTest,
    "UnrealAgentLink.Assets.PBRTextureNaming",
    EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUALPBRTextureNamingTest::RunTest(const FString& Parameters)
{
    // 枚举按名字比，失败时报出来的是 albedo / packed_orm 这种能读的字
    auto TestType = [this](const TCHAR* TextureName, EUAL_PBRTextureType Expected)
    {
        TestEqual(TextureName,
            FString(FUAL_PBRMaterialHelper::GetTextureTypeName(FUAL_PBRMaterialHelper::ClassifyTexture(TextureName))),
            FString(FUAL_PBRMaterialHelper::GetTextureTypeName(Expected)));
    };
    auto TestSameBase = [this](const TCHAR* What, const TCHAR* A, const TCHAR* B)
    {
        TestEqual(What, FUAL_PBRMaterialHelper::ExtractBaseName(A), FUAL_PBRMaterialHelper::ExtractBaseName(B));
    };

    // 写成像素数的分辨率：分类跳过它，基名也得摘掉它，ARM 才能和法线分到一组
    {
        TestType(TEXT("rock_arm_2048"), EUAL_PBRTextureType::PackedORM);
        TestType(TEXT("rock_nor_gl_2048"), EUAL_PBRTextureType::Normal);
        TestSameBase(TEXT("arm/nor_gl with 2048"), TEXT("rock_arm_2048"), TEXT("rock_nor_gl_2048"));
        TestEqual(TEXT("2048 stripped"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("rock_arm_2048")), FString(TEXT("rock")));
        TestEqual(TEXT("Nk stripped"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("rock_nor_gl_4k")), FString(TEXT("rock")));
        TestEqual(TEXT("resolution before convention"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("T_Rock_Normal_2048_GL")), FString(TEXT("T_Rock")));
    }

    // 末尾两位编号：同上，T_Rock_ARM_01 和 T_Rock_Normal_01 一组
    {
        TestType(TEXT("T_Rock_ARM_01"), EUAL_PBRTextureType::PackedORM);
        TestType(TEXT("T_Rock_Normal_01"), EUAL_PBRTextureType::Normal);
        TestSameBase(TEXT("ARM/Normal with _01"), TEXT("T_Rock_ARM_01"), TEXT("T_Rock_Normal_01"));
        TestEqual(TEXT("_01 stripped"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("T_Rock_ARM_01")), FString(TEXT("T_Rock")));
    }

    // 不是分辨率的数字不摘：一位数、非 2 的幂的三四位数可能是编号
    {
        TestEqual(TEXT("single digit kept"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("T_Rock_ARM_1")), FString(TEXT("T_Rock_ARM_1")));
        TestEqual(TEXT("1000 kept"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("T_Wall_1000_Albedo")), FString(TEXT("T_Wall_1000")));
        TestEqual(TEXT("1000 is not a resolution"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("T_Wall_Albedo_1000")), FString(TEXT("T_Wall_Albedo_1000")));
    }

    // Poly Haven 标准命名：diff / nor_gl / rough / arm / disp，全是一套
    {
        const TCHAR* PolyHaven[] = {
            TEXT("aerial_rocks_02_diff_4k"),
            TEXT("aerial_rocks_02_nor_gl_4k"),
            TEXT("aerial_rocks_02_rough_4k"),
            TEXT("aerial_rocks_02_arm_4k"),
            TEXT("aerial_rocks_02_disp_4k"),
        };
        TestType(PolyHaven[0], EUAL_PBRTextureType::Albedo);
        TestType(PolyHaven[1], EUAL_PBRTextureType::Normal);
        TestType(PolyHaven[2], EUAL_PBRTextureType::Roughness);
        TestType(PolyHaven[3], EUAL_PBRTextureType::PackedORM);
        TestType(PolyHaven[4], EUAL_PBRTextureType::Height);

        const FString Base = FUAL_PBRMaterialHelper::ExtractBaseName(PolyHaven[0]);
        TestTrue(TEXT("poly haven base keeps asset name"), Base.StartsWith(TEXT("aerial_rocks")));
        for (const TCHAR* Name : PolyHaven)
        {
            TestEqual(Name, FUAL_PBRMaterialHelper::ExtractBaseName(Name), Base);
        }
    }

    // diff / disp 只按整词认，名字里碰巧带这几个字母的不算
    {
        TestType(TEXT("T_Rock_Diff"), EUAL_PBRTextureType::Albedo);
        TestType(TEXT("T_Different_Normal"), EUAL_PBRTextureType::Normal);
        TestEqual(TEXT("Different not stripped"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("T_Rock_Different")), FString(TEXT("T_Rock_Different")));
        TestEqual(TEXT("Display not stripped"), FUAL_PBRMaterialHelper::ExtractBaseName(TEXT("T_Rock_Display")), FString(TEXT("T_Rock_Display")));
    }

    // 透明遮罩不是打包遮罩，基名和颜色图对得上
    {
        TestType(TEXT("T_Leaf_Opacity_Mask"), EUAL_PBRTextureType::Opacity);
        TestSameBase(TEXT("opacity mask with albedo"), TEXT("T_Leaf_Opacity_Mask"), TEXT("T_Leaf_Albedo"));
    }

    // 只凭末尾 Mask / Arm 认的打包图：分类照认，落单的在分组时丢掉，有同套图撑着才留
    {
        TestType(TEXT("T_Gas_Mask"), EUAL_PBRTextureType::PackedMask);
        TestType(TEXT("T_Robot_Arm"), EUAL_PBRTextureType::PackedORM);

        // 独立的临时包装贴图：名字就是分类用的名字，每次跑都不撞名
        UPackage* Package = CreatePackage(*FString::Printf(TEXT("/Temp/UAL_PBRTextureNamingTest_%s"),
            *FGuid::NewGuid().ToString(EGuidFormats::Digits)));
        Package->SetFlags(RF_Transient);
        auto MakeTexture = [Package](const TCHAR* Name)
        {
            return NewObject<UTexture2D>(Package, FName(Name), RF_Transient);
        };
        auto FindGroup = [](const TArray<FUAL_TextureGroup>& Groups, const FString& BaseName) -> const FUAL_TextureGroup*
        {
            for (const FUAL_TextureGroup& Group : Groups)
            {
                if (Group.BaseName == BaseName)
                {
                    return &Group;
                }
            }
            return nullptr;
        };

        // 一张孤零零的 T_Gas_Mask：多半是面具的颜色图，不进任何组。
        // 丢掉时会打一条警告，整个用例只该出这一条（ARM 被误丢也会打，次数对不上就算失败）
        AddExpectedError(TEXT("no PBR set around a bare Arm/Mask name"), EAutomationExpectedErrorFlags::Contains, 1);
        {
            const TArray<FUAL_TextureGroup> Groups = FUAL_PBRMaterialHelper::GroupTexturesByAsset({ MakeTexture(TEXT("T_Gas_Mask")) });
            TestEqual(TEXT("lone mask dropped"), Groups.Num(), 0);
        }

        // ARM 后面跟 2048 / 01，照样和同套图分到一组，不被当成手臂图丢掉
        {
            const TArray<FUAL_TextureGroup> Groups = FUAL_PBRMaterialHelper::GroupTexturesByAsset({
                MakeTexture(TEXT("rock_arm_2048")), MakeTexture(TEXT("rock_nor_gl_2048")),
                MakeTexture(TEXT("T_Rock_ARM_01")), MakeTexture(TEXT("T_Rock_Normal_01")) });
            TestEqual(TEXT("two sets"), Groups.Num(), 2);
            const FUAL_TextureGroup* Rock = FindGroup(Groups, TEXT("rock"));
            const FUAL_TextureGroup* TRock = FindGroup(Groups, TEXT("T_Rock"));
            TestTrue(TEXT("rock_*_2048 keeps arm"), Rock && Rock->Textures.Contains(EUAL_PBRTextureType::PackedORM) &&
                Rock->Textures.Contains(EUAL_PBRTextureType::Normal));
            TestTrue(TEXT("T_Rock_*_01 keeps arm"), TRock && TRock->Textures.Contains(EUAL_PBRTextureType::PackedORM) &&
                TRock->Textures.Contains(EUAL_PBRTextureType::Normal));
        }

        // Poly Haven 一整套 → 一组，五张图各就各位（只出一个 MI）
        {
            const TArray<FUAL_TextureGroup> Groups = FUAL_PBRMaterialHelper::GroupTexturesByAsset({
                MakeTexture(TEXT("aerial_rocks_02_diff_4k")), MakeTexture(TEXT("aerial_rocks_02_nor_gl_4k")),
                MakeTexture(TEXT("aerial_rocks_02_rough_4k")), MakeTexture(TEXT("aerial_rocks_02_arm_4k")),
                MakeTexture(TEXT("aerial_rocks_02_disp_4k")) });
            TestEqual(TEXT("poly haven one group"), Groups.Num(), 1);
            if (Groups.Num() == 1)
            {
                TestEqual(TEXT("poly haven group size"), Groups[0].Textures.Num(), 5);
                TestTrue(TEXT("poly haven albedo"), Groups[0].Textures.Contains(EUAL_PBRTextureType::Albedo));
                TestTrue(TEXT("poly haven height"), Groups[0].Textures.Contains(EUAL_PBRTextureType::Height));
                TestTrue(TEXT("poly haven arm"), Groups[0].Textures.Contains(EUAL_PBRTextureType::PackedORM));
            }
        }
    }

    return true;
}

#endif
